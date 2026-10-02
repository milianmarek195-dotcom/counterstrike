import { Injectable, Logger } from '@nestjs/common';
import type { SkinVariant, SkinWear } from '@celtist/database';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { SkinCatalogSource, SkinPriceProvider, WEAR_NAMES, marketHashName, wearEnumFor } from './skin-catalog.js';

const CHUNK = 25;

export interface PriceSyncResult {
  provider: string;
  ok: boolean;
  matched: number;
  skinsPriced: number;
  error?: string;
}

/**
 * Keeps the skin database current. Nothing about skins is hard-coded: the catalog comes from a source, prices from a
 * provider, both behind interfaces. When a source is down the last known data stays in place (levels keep working
 * on the most recent price, and every price carries its timestamp).
 */
@Injectable()
export class SkinSyncService {
  private readonly logger = new Logger(SkinSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly catalog: SkinCatalogSource,
    private readonly prices: SkinPriceProvider,
  ) {}

  async syncCatalog(): Promise<{ skins: number; stickers: number }> {
    const [skins, stickers] = await Promise.all([this.catalog.fetchSkins(), this.catalog.fetchStickers()]);
    for (let i = 0; i < skins.length; i += CHUNK) {
      await Promise.all(
        skins.slice(i, i + CHUNK).map((s) => {
          const data = {
            externalId: s.externalId,
            weaponClass: s.weaponClass,
            weaponName: s.weaponName,
            slot: s.slot,
            name: s.name,
            rarity: s.rarity,
            collection: s.collection,
            minFloat: s.minFloat,
            maxFloat: s.maxFloat,
            statTrakAvailable: s.statTrakAvailable,
            souvenirAvailable: s.souvenirAvailable,
            imageUrl: s.imageUrl,
            active: true,
          };
          return this.prisma.skin.upsert({
            where: { weaponDefIndex_paintIndex: { weaponDefIndex: s.weaponDefIndex, paintIndex: s.paintIndex } },
            create: { ...data, weaponDefIndex: s.weaponDefIndex, paintIndex: s.paintIndex },
            update: data,
          });
        }),
      );
    }
    for (let i = 0; i < stickers.length; i += CHUNK) {
      await Promise.all(
        stickers.slice(i, i + CHUNK).map((s) =>
          this.prisma.sticker.upsert({
            where: { defIndex: s.defIndex },
            create: { externalId: s.externalId, defIndex: s.defIndex, name: s.name, rarity: s.rarity, tournament: s.tournament, imageUrl: s.imageUrl },
            update: { externalId: s.externalId, name: s.name, rarity: s.rarity, tournament: s.tournament, imageUrl: s.imageUrl },
          }),
        ),
      );
    }
    this.logger.log(`Catalog synced: ${skins.length} skins, ${stickers.length} stickers`);
    return { skins: skins.length, stickers: stickers.length };
  }

  /** Never throws: a failing provider leaves the stored prices untouched and is reported in the result. */
  async syncPrices(): Promise<PriceSyncResult> {
    let market: Map<string, number>;
    try {
      market = await this.prices.fetchPrices();
    } catch (error) {
      this.logger.warn(`Price provider ${this.prices.name} failed, keeping last known prices: ${(error as Error).message}`);
      return { provider: this.prices.name, ok: false, matched: 0, skinsPriced: 0, error: (error as Error).message };
    }
    if (market.size === 0) return { provider: this.prices.name, ok: true, matched: 0, skinsPriced: 0 };

    const now = this.clock.now();
    const skins = await this.prisma.skin.findMany({
      where: { active: true },
      select: { id: true, weaponName: true, name: true, slot: true, statTrakAvailable: true, souvenirAvailable: true, prices: { select: { wear: true, variant: true, priceUsd: true } } },
    });

    const creates: Array<{ skinId: string; wear: SkinWear; variant: SkinVariant; priceUsd: number; source: string; fetchedAt: Date }> = [];
    const updates: Array<{ skinId: string; wear: SkinWear; variant: SkinVariant; priceUsd: number }> = [];
    const maxBySkin = new Map<string, number>();

    for (const skin of skins) {
      const existing = new Map(skin.prices.map((p) => [`${p.wear}:${p.variant}`, p.priceUsd] as const));
      const variants: SkinVariant[] = ['NORMAL', ...(skin.statTrakAvailable ? (['STATTRAK'] as const) : []), ...(skin.souvenirAvailable ? (['SOUVENIR'] as const) : [])];
      for (const wearName of WEAR_NAMES) {
        const wear = wearEnumFor(wearName)!;
        for (const variant of variants) {
          const price = market.get(marketHashName(skin, wearName, variant));
          if (price === undefined) continue;
          maxBySkin.set(skin.id, Math.max(maxBySkin.get(skin.id) ?? 0, price));
          const previous = existing.get(`${wear}:${variant}`);
          if (previous === undefined) creates.push({ skinId: skin.id, wear, variant, priceUsd: price, source: this.prices.name, fetchedAt: now });
          else updates.push({ skinId: skin.id, wear, variant, priceUsd: price });
        }
      }
    }

    for (let i = 0; i < creates.length; i += 1000) await this.prisma.skinPrice.createMany({ data: creates.slice(i, i + 1000), skipDuplicates: true });
    for (let i = 0; i < updates.length; i += CHUNK) {
      await Promise.all(
        updates.slice(i, i + CHUNK).map((u) =>
          this.prisma.skinPrice.update({
            where: { skinId_wear_variant: { skinId: u.skinId, wear: u.wear, variant: u.variant } },
            data: { priceUsd: u.priceUsd, source: this.prices.name, fetchedAt: now },
          }),
        ),
      );
    }
    const priced = [...maxBySkin.entries()];
    for (let i = 0; i < priced.length; i += CHUNK) {
      await Promise.all(priced.slice(i, i + CHUNK).map(([id, max]) => this.prisma.skin.update({ where: { id }, data: { priceMaxUsd: max, priceUpdatedAt: now } })));
    }
    this.logger.log(`Prices synced from ${this.prices.name}: ${creates.length + updates.length} prices for ${priced.length} skins`);
    return { provider: this.prices.name, ok: true, matched: creates.length + updates.length, skinsPriced: priced.length };
  }
}
