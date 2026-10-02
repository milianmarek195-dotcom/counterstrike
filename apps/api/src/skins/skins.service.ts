import { Injectable } from '@nestjs/common';
import type { Prisma } from '@celtist/database';
import { requiredSkinLevel, resolveSkinPrice, type SkinInfo, type SkinPriceEntry } from '@celtist/shared';
import { notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

/** Read side of the skin database: search, details with per-wear prices and the level each item needs. */
@Injectable()
export class SkinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async search(query: { q?: string; slot?: string; weaponDefIndex?: number; maxPrice?: number; page: number; pageSize: number }) {
    const where: Prisma.SkinWhereInput = {
      active: true,
      ...(query.slot ? { slot: query.slot as never } : {}),
      ...(query.weaponDefIndex ? { weaponDefIndex: query.weaponDefIndex } : {}),
      ...(query.maxPrice ? { priceMaxUsd: { lte: query.maxPrice } } : {}),
      ...(query.q
        ? { OR: query.q.split(/\s+/).filter(Boolean).length > 1
            ? [{ AND: query.q.split(/\s+/).filter(Boolean).map((word) => ({ OR: [{ name: { contains: word, mode: 'insensitive' as const } }, { weaponName: { contains: word, mode: 'insensitive' as const } }] })) }]
            : [{ name: { contains: query.q, mode: 'insensitive' as const } }, { weaponName: { contains: query.q, mode: 'insensitive' as const } }] }
        : {}),
    };
    const thresholds = await this.settings.get('skin.thresholds');
    const [total, rows] = await Promise.all([
      this.prisma.skin.count({ where }),
      this.prisma.skin.findMany({ where, orderBy: [{ weaponName: 'asc' }, { name: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      skins: rows.map((s) => ({
        id: s.id,
        weaponDefIndex: s.weaponDefIndex,
        weaponName: s.weaponName,
        slot: s.slot,
        paintIndex: s.paintIndex,
        name: s.name,
        rarity: s.rarity,
        collection: s.collection,
        minFloat: s.minFloat,
        maxFloat: s.maxFloat,
        statTrakAvailable: s.statTrakAvailable,
        souvenirAvailable: s.souvenirAvailable,
        imageUrl: s.imageUrl,
        priceMaxUsd: s.priceMaxUsd,
        priceUpdatedAt: s.priceUpdatedAt,
        // Highest level any wear of this skin may need (conservative; see detail for per-wear levels).
        requiredLevel: requiredSkinLevel(s.priceMaxUsd, thresholds),
      })),
    };
  }

  async detail(id: string) {
    const skin = await this.prisma.skin.findUnique({ where: { id }, include: { prices: true } });
    if (!skin) throw notFound('SKIN_NOT_FOUND', 'Skin does not exist');
    const thresholds = await this.settings.get('skin.thresholds');
    return {
      id: skin.id,
      weaponDefIndex: skin.weaponDefIndex,
      weaponName: skin.weaponName,
      slot: skin.slot,
      paintIndex: skin.paintIndex,
      name: skin.name,
      rarity: skin.rarity,
      collection: skin.collection,
      minFloat: skin.minFloat,
      maxFloat: skin.maxFloat,
      statTrakAvailable: skin.statTrakAvailable,
      souvenirAvailable: skin.souvenirAvailable,
      imageUrl: skin.imageUrl,
      prices: skin.prices.map((p) => ({ wear: p.wear, variant: p.variant, priceUsd: p.priceUsd, source: p.source, fetchedAt: p.fetchedAt, requiredLevel: requiredSkinLevel(p.priceUsd, thresholds) })),
    };
  }

  async searchStickers(query: { q?: string; page: number; pageSize: number }) {
    const where: Prisma.StickerWhereInput = { active: true, ...(query.q ? { name: { contains: query.q, mode: 'insensitive' } } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.sticker.count({ where }),
      this.prisma.sticker.findMany({ where, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, stickers: rows };
  }

  /** Skins as the pure rules in packages/shared need them (with price table). */
  async infoFor(ids: readonly string[]): Promise<Map<string, SkinInfo>> {
    const rows = await this.prisma.skin.findMany({ where: { id: { in: [...new Set(ids)] } }, include: { prices: true } });
    return new Map(
      rows.map((s) => [
        s.id,
        {
          id: s.id,
          weaponDefIndex: s.weaponDefIndex,
          slot: s.slot,
          minFloat: s.minFloat,
          maxFloat: s.maxFloat,
          statTrakAvailable: s.statTrakAvailable,
          souvenirAvailable: s.souvenirAvailable,
          prices: s.prices.map((p) => ({ wear: p.wear, variant: p.variant, priceUsd: p.priceUsd }) as SkinPriceEntry),
        } satisfies SkinInfo,
      ]),
    );
  }

  /** Price used for gating a specific configuration (exposed for the admin UI). */
  priceFor(info: SkinInfo, wear: SkinPriceEntry['wear'], variant: SkinPriceEntry['variant']): number | null {
    return resolveSkinPrice(info.prices, wear, variant);
  }
}
