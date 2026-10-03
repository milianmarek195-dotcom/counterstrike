import type { LoadoutSlot } from '@celtist/shared';

/** Catalog entries as the platform stores them (one per skin, wears listed separately). */
export interface CatalogSkin {
  externalId: string;
  weaponDefIndex: number;
  weaponClass: string;
  weaponName: string;
  slot: LoadoutSlot;
  paintIndex: number;
  name: string;
  /** Finish variant that shares the name with others (e.g. Doppler Phase 2, Ruby). */
  phase?: string | null;
  rarity: string | null;
  collection: string | null;
  minFloat: number;
  maxFloat: number;
  statTrakAvailable: boolean;
  souvenirAvailable: boolean;
  imageUrl: string | null;
  /** The finish belongs to the old weapon model (CS2 keeps both meshes in one weapon). */
  legacyModel?: boolean;
  /** Agents only. */
  modelPath?: string | null;
  side?: 'T' | 'CT' | null;
}

export interface CatalogSticker {
  externalId: string;
  defIndex: number;
  name: string;
  rarity: string | null;
  tournament: string | null;
  imageUrl: string | null;
}

/** Where skin and sticker data come from (interface: tests and offline setups supply their own). */
export abstract class SkinCatalogSource {
  abstract fetchSkins(): Promise<CatalogSkin[]>;
  abstract fetchStickers(): Promise<CatalogSticker[]>;
}

/** A price observation for one market item name. */
export interface MarketPrice {
  marketHashName: string;
  priceUsd: number;
}

export abstract class SkinPriceProvider {
  abstract readonly name: string;
  /** Returns prices keyed by exact market hash name. Throws if the provider is unavailable. */
  abstract fetchPrices(): Promise<Map<string, number>>;
}

const KNIFE_PREFIX = /^weapon_(knife|bayonet)/;
const SHOTGUNS = new Set(['weapon_nova', 'weapon_xm1014', 'weapon_mag7', 'weapon_sawedoff']);
const MACHINE_GUNS = new Set(['weapon_m249', 'weapon_negev']);
const SMGS = new Set(['weapon_mac10', 'weapon_mp9', 'weapon_mp7', 'weapon_mp5sd', 'weapon_ump45', 'weapon_p90', 'weapon_bizon']);
const PISTOLS = new Set(['weapon_glock', 'weapon_hkp2000', 'weapon_usp_silencer', 'weapon_p250', 'weapon_fiveseven', 'weapon_tec9', 'weapon_cz75a', 'weapon_deagle', 'weapon_elite', 'weapon_revolver']);

/** Which loadout slot a weapon belongs to (by engine class name, with the catalog category as fallback). */
export function slotForWeapon(weaponClass: string, categoryId: string | null): LoadoutSlot | null {
  if (weaponClass === 'weapon_awp') return 'AWP';
  if (KNIFE_PREFIX.test(weaponClass) || categoryId === 'sfui_invpanel_filter_melee') return 'KNIFE';
  if (categoryId === 'sfui_invpanel_filter_gloves' || weaponClass.startsWith('leather_') || weaponClass.startsWith('studded_') || weaponClass.startsWith('sporty_') || weaponClass.startsWith('slick_') || weaponClass.startsWith('specialist_') || weaponClass === 'motorcycle_gloves' || weaponClass === 'brokenfang_gloves') return 'GLOVES';
  if (SHOTGUNS.has(weaponClass)) return 'SHOTGUN';
  if (MACHINE_GUNS.has(weaponClass)) return 'MACHINE_GUN';
  if (SMGS.has(weaponClass)) return 'SMG';
  if (PISTOLS.has(weaponClass)) return 'PISTOL';
  if (categoryId === 'csgo_inventory_weapon_category_rifles' || /^weapon_(ak47|m4a1|m4a1_silencer|famas|galilar|aug|sg556|ssg08|scar20|g3sg1)$/.test(weaponClass)) return 'RIFLE';
  if (categoryId === 'csgo_inventory_weapon_category_pistols') return 'PISTOL';
  if (categoryId === 'csgo_inventory_weapon_category_smgs') return 'SMG';
  return null;
}

export const WEAR_NAMES = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const;

/** The market name of one wear/variant of a skin, e.g. "★ StatTrak™ Karambit | Doppler (Factory New)". */
export function marketHashName(skin: { weaponName: string; name: string; slot: LoadoutSlot }, wear: string, variant: 'NORMAL' | 'STATTRAK' | 'SOUVENIR'): string {
  if (skin.slot === 'AGENT') return skin.weaponName; // agents have a plain market name, no wear
  const star = skin.slot === 'KNIFE' || skin.slot === 'GLOVES' ? '★ ' : '';
  const prefix = variant === 'STATTRAK' ? 'StatTrak™ ' : variant === 'SOUVENIR' ? 'Souvenir ' : '';
  const base = skin.name ? `${skin.weaponName} | ${skin.name}` : skin.weaponName;
  return `${star}${prefix}${base}${wear === 'NONE' ? '' : ` (${wear})`}`;
}

export function wearEnumFor(name: string): 'FACTORY_NEW' | 'MINIMAL_WEAR' | 'FIELD_TESTED' | 'WELL_WORN' | 'BATTLE_SCARRED' | null {
  switch (name) {
    case 'Factory New':
      return 'FACTORY_NEW';
    case 'Minimal Wear':
      return 'MINIMAL_WEAR';
    case 'Field-Tested':
      return 'FIELD_TESTED';
    case 'Well-Worn':
      return 'WELL_WORN';
    case 'Battle-Scarred':
      return 'BATTLE_SCARRED';
    default:
      return null;
  }
}
