import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch } from '../steam/steam-openid.service.js';
import { SkinCatalogSource, SkinPriceProvider, slotForWeapon, type CatalogSkin, type CatalogSticker } from './skin-catalog.js';

interface RawSkin {
  skin_id?: string;
  id: string;
  name: string;
  weapon?: { id?: string; weapon_id?: number; name?: string };
  category?: { id?: string };
  pattern?: { name?: string };
  min_float?: number | null;
  max_float?: number | null;
  stattrak?: boolean;
  souvenir?: boolean;
  paint_index?: string | number | null;
  phase?: string | null;
  rarity?: { name?: string };
  collections?: Array<{ name?: string }>;
  image?: string;
}

interface RawSticker {
  id: string;
  name: string;
  def_index?: string | number;
  rarity?: { name?: string };
  tournament?: { name?: string } | null;
  image?: string;
}

interface RawAgent {
  id: string;
  name: string;
  def_index?: string | number;
  rarity?: { name?: string };
  collections?: Array<{ name?: string }>;
  team?: { id?: string };
  image?: string;
  model_player?: string;
}

const httpsOrNull = (url?: string): string | null => (url && url.startsWith('https://') ? url : null);

/** Catalog from the community-maintained CSGO-API dataset (static JSON on GitHub; no key, versioned, mirrored on a CDN). */
@Injectable()
export class CsgoApiCatalogSource extends SkinCatalogSource {
  private readonly logger = new Logger(CsgoApiCatalogSource.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetcher: HttpFetch,
  ) {
    super();
  }

  override async fetchSkins(): Promise<CatalogSkin[]> {
    const raw = await this.json<RawSkin[]>(this.config.env.SKIN_CATALOG_URL);
    const bySkin = new Map<string, CatalogSkin>();
    for (const entry of raw) {
      const weaponClass = entry.weapon?.id;
      const defIndex = entry.weapon?.weapon_id;
      const paintIndex = Number(entry.paint_index);
      if (!weaponClass || !defIndex || !Number.isInteger(paintIndex) || paintIndex < 0) continue;
      const slot = slotForWeapon(weaponClass, entry.category?.id ?? null);
      if (!slot) continue;

      const key = `${defIndex}:${paintIndex}`;
      const existing = bySkin.get(key);
      const min = entry.min_float ?? 0;
      const max = entry.max_float ?? 1;
      if (existing) {
        // The dataset lists one entry per wear: merge them into one skin with the widest float range.
        existing.minFloat = Math.min(existing.minFloat, min);
        existing.maxFloat = Math.max(existing.maxFloat, max);
        existing.statTrakAvailable ||= !!entry.stattrak;
        existing.souvenirAvailable ||= !!entry.souvenir;
        continue;
      }
      bySkin.set(key, {
        externalId: entry.skin_id ?? entry.id,
        weaponDefIndex: defIndex,
        weaponClass,
        weaponName: entry.weapon?.name ?? weaponClass,
        slot,
        paintIndex,
        name: entry.pattern?.name ?? '',
        phase: entry.phase?.trim() ? entry.phase.trim().slice(0, 32) : null,
        rarity: entry.rarity?.name ?? null,
        collection: entry.collections?.[0]?.name ?? null,
        minFloat: Math.max(0, min),
        maxFloat: Math.min(1, max),
        statTrakAvailable: !!entry.stattrak,
        souvenirAvailable: !!entry.souvenir,
        imageUrl: httpsOrNull(entry.image),
      });
    }
    try {
      for (const agent of await this.fetchAgents()) bySkin.set(`${agent.weaponDefIndex}:0`, agent);
    } catch (error) {
      // agents are optional: a failing agent list must never block the weapon catalog
      this.logger.warn(`Agent catalog failed: ${(error as Error).message}`);
    }
    return [...bySkin.values()];
  }

  private async fetchAgents(): Promise<CatalogSkin[]> {
    const raw = await this.json<RawAgent[]>(this.config.env.AGENT_CATALOG_URL);
    const agents: CatalogSkin[] = [];
    for (const a of raw) {
      const defIndex = Number(a.def_index);
      const side = a.team?.id === 'terrorists' ? 'T' : a.team?.id === 'counter-terrorists' ? 'CT' : null;
      if (!Number.isInteger(defIndex) || defIndex <= 0 || !side || !a.model_player) continue;
      agents.push({
        externalId: a.id,
        weaponDefIndex: defIndex,
        weaponClass: 'agent',
        weaponName: a.name.slice(0, 64),
        slot: 'AGENT',
        paintIndex: 0,
        name: '',
        rarity: a.rarity?.name ?? null,
        collection: a.collections?.[0]?.name ?? null,
        minFloat: 0,
        maxFloat: 1,
        statTrakAvailable: false,
        souvenirAvailable: false,
        imageUrl: httpsOrNull(a.image),
        // the dataset lists the agents/ path; the game resource lives under characters/
        modelPath: a.model_player.replace(/^agents\/models\//, 'characters/models/'),
        side,
      });
    }
    return agents;
  }

  override async fetchStickers(): Promise<CatalogSticker[]> {
    const raw = await this.json<RawSticker[]>(this.config.env.STICKER_CATALOG_URL);
    return raw
      .map((s) => ({ externalId: s.id, defIndex: Number(s.def_index), name: s.name.replace(/^Sticker \| /, ''), rarity: s.rarity?.name ?? null, tournament: s.tournament?.name ?? null, imageUrl: httpsOrNull(s.image) }))
      .filter((s) => Number.isInteger(s.defIndex) && s.defIndex > 0);
  }

  private async json<T>(url: string): Promise<T> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(60_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Catalog source answered ${response.status}`);
    return (await response.json()) as T;
  }
}

interface SkinportItem {
  market_hash_name: string;
  min_price: number | null;
  suggested_price: number | null;
  median_price: number | null;
}

/**
 * Prices from Skinport's public item list. Their limits are respected: one request per sync (the endpoint allows 8 per
 * 5 minutes and caches for 5 minutes), Brotli requested as required. Unlisted items fall back to the suggested price.
 */
@Injectable()
export class SkinportPriceProvider extends SkinPriceProvider {
  override readonly name = 'skinport';

  constructor(@Inject(HTTP_FETCH) private readonly fetcher: HttpFetch) {
    super();
  }

  override async fetchPrices(): Promise<Map<string, number>> {
    const response = await this.fetcher('https://api.skinport.com/v1/items?app_id=730&currency=USD', {
      headers: { 'accept-encoding': 'br', accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Skinport answered ${response.status}`);
    const items = (await response.json()) as SkinportItem[];
    const prices = new Map<string, number>();
    for (const item of items) {
      const price = item.min_price ?? item.suggested_price ?? item.median_price;
      if (price !== null && Number.isFinite(price) && price >= 0) prices.set(item.market_hash_name, price);
    }
    return prices;
  }
}

/** Used when SKIN_PRICE_PROVIDER=none: no prices, so the conservative "unknown price" level applies. */
@Injectable()
export class NoPriceProvider extends SkinPriceProvider {
  override readonly name = 'none';

  override async fetchPrices(): Promise<Map<string, number>> {
    return new Map();
  }
}
