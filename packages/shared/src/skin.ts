import type { LoadoutSlot } from './constants.js';
import type { SkinLevel } from './permissions.js';

/**
 * Skin-changer rules that must hold on the server no matter what the client sends:
 * float range, price based level gating, temporary permissions and per-item permission filtering.
 * Nothing here touches Steam inventories – it only decides what a controlled game server may display.
 */

export const FLOAT_MIN = 0;
export const FLOAT_MAX = 1;
export const PAINT_SEED_MIN = 0;
export const PAINT_SEED_MAX = 1000;
export const STICKER_SLOT_COUNT = 5;
export const NAME_TAG_MAX_LENGTH = 20;
/** Float applied when a player may not edit floats. */
export const DEFAULT_FLOAT = 0.001;

export const SKIN_WEARS = ['FACTORY_NEW', 'MINIMAL_WEAR', 'FIELD_TESTED', 'WELL_WORN', 'BATTLE_SCARRED'] as const;
export type SkinWear = (typeof SKIN_WEARS)[number] | 'NONE';
export type SkinVariant = 'NORMAL' | 'STATTRAK' | 'SOUVENIR';

export function isValidFloat(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= FLOAT_MIN && value <= FLOAT_MAX;
}

/** Wear bucket for a float value (Valve's boundaries: 0.07 / 0.15 / 0.38 / 0.45). */
export function floatToWear(value: number): Exclude<SkinWear, 'NONE'> {
  if (!isValidFloat(value)) throw new RangeError(`Float out of range: ${value}`);
  if (value < 0.07) return 'FACTORY_NEW';
  if (value < 0.15) return 'MINIMAL_WEAR';
  if (value < 0.38) return 'FIELD_TESTED';
  if (value < 0.45) return 'WELL_WORN';
  return 'BATTLE_SCARRED';
}

export function defaultFloatFor(skin: Pick<SkinInfo, 'minFloat' | 'maxFloat'>): number {
  return Math.min(skin.maxFloat, Math.max(skin.minFloat, DEFAULT_FLOAT));
}

// ───────────────────────── Levels by market price ─────────────────────────

export interface SkinLevelThresholds {
  /** Level 1 covers skins strictly below this price. */
  level1MaxUsd: number;
  /** Level 2 covers skins strictly below this price. */
  level2MaxUsd: number;
  /** Level assumed for skins without any known price (conservative: highest). */
  unknownPriceLevel: SkinLevel;
}

export const DEFAULT_SKIN_LEVEL_THRESHOLDS: Readonly<SkinLevelThresholds> = {
  level1MaxUsd: 250,
  level2MaxUsd: 1000,
  unknownPriceLevel: 3,
};

/** Minimum level needed to use a skin priced at `priceUsd` (1, 2 or 3). */
export function requiredSkinLevel(
  priceUsd: number | null | undefined,
  thresholds: SkinLevelThresholds = DEFAULT_SKIN_LEVEL_THRESHOLDS,
): SkinLevel {
  if (priceUsd === null || priceUsd === undefined || !Number.isFinite(priceUsd)) {
    return thresholds.unknownPriceLevel;
  }
  if (priceUsd < thresholds.level1MaxUsd) return 1;
  if (priceUsd < thresholds.level2MaxUsd) return 2;
  return 3;
}

export interface SkinPriceEntry {
  wear: SkinWear;
  variant: SkinVariant;
  priceUsd: number;
}

/**
 * Price used for gating. Exact wear/variant match first; otherwise the highest known price of the skin
 * (never underestimate); null when the skin has no price at all.
 */
export function resolveSkinPrice(
  prices: readonly SkinPriceEntry[],
  wear: SkinWear,
  variant: SkinVariant,
): number | null {
  if (prices.length === 0) return null;
  const exact = prices.find((p) => p.wear === wear && p.variant === variant);
  if (exact) return exact.priceUsd;
  return prices.reduce((max, p) => Math.max(max, p.priceUsd), 0);
}

// ───────────────────────── Temporary permissions ─────────────────────────

export interface SkinPermissionGrant {
  level: number;
  stickerCrafts: boolean;
  floatEditing: boolean;
  customLoadouts: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface EffectiveSkinPermission {
  level: SkinLevel;
  stickerCrafts: boolean;
  floatEditing: boolean;
  customLoadouts: boolean;
  expiresAt: Date | null;
  source: 'grant' | 'default';
}

export const NO_SKIN_PERMISSION: Readonly<EffectiveSkinPermission> = {
  level: 0,
  stickerCrafts: false,
  floatEditing: false,
  customLoadouts: true,
  expiresAt: null,
  source: 'default',
};

function clampLevel(level: number): SkinLevel {
  return Math.min(3, Math.max(0, Math.trunc(level))) as SkinLevel;
}

/**
 * Evaluates grants at read time: the newest grant counts; if it is revoked or expired the player is back
 * on the platform default (older grants never come back). The expiry job only tidies up and notifies –
 * correctness never depends on it running on time.
 */
export function effectiveSkinPermission(
  grants: readonly SkinPermissionGrant[],
  now: Date,
  fallback: Readonly<EffectiveSkinPermission> = NO_SKIN_PERMISSION,
): EffectiveSkinPermission {
  const newest = grants.reduce<SkinPermissionGrant | null>(
    (best, g) => (best === null || g.createdAt.getTime() > best.createdAt.getTime() ? g : best),
    null,
  );
  if (!newest || newest.revokedAt) return { ...fallback };
  if (newest.expiresAt && newest.expiresAt.getTime() <= now.getTime()) return { ...fallback };
  return {
    level: clampLevel(newest.level),
    stickerCrafts: newest.stickerCrafts,
    floatEditing: newest.floatEditing,
    customLoadouts: newest.customLoadouts,
    expiresAt: newest.expiresAt,
    source: 'grant',
  };
}

export const SKIN_DURATION_PRESETS = [
  { key: '15m', label: '15 minutes', ms: 15 * 60_000 },
  { key: '1h', label: '1 hour', ms: 60 * 60_000 },
  { key: '2h', label: '2 hours', ms: 2 * 60 * 60_000 },
  { key: '1d', label: '1 day', ms: 24 * 60 * 60_000 },
  { key: '7d', label: '7 days', ms: 7 * 24 * 60 * 60_000 },
  { key: 'permanent', label: 'Permanent', ms: null },
] as const;
export type SkinDurationKey = (typeof SKIN_DURATION_PRESETS)[number]['key'];

export const MAX_CUSTOM_DURATION_MS = 365 * 24 * 60 * 60_000;

/** Expiry for a grant: a preset key, "custom" with minutes, or permanent (null). */
export function resolveGrantExpiry(duration: string, customMinutes: number | undefined, now: Date): Date | null {
  if (duration === 'custom') {
    if (customMinutes === undefined || !Number.isFinite(customMinutes) || customMinutes < 1) throw new RangeError('A custom duration needs minutes');
    return new Date(now.getTime() + Math.min(customMinutes * 60_000, MAX_CUSTOM_DURATION_MS));
  }
  return expiryFromPreset(duration as SkinDurationKey, now);
}

/** Expiry timestamp for a preset key, or null for permanent. */
export function expiryFromPreset(key: SkinDurationKey, now: Date): Date | null {
  const preset = SKIN_DURATION_PRESETS.find((p) => p.key === key);
  if (!preset) throw new RangeError(`Unknown duration preset: ${key}`);
  return preset.ms === null ? null : new Date(now.getTime() + preset.ms);
}

// ───────────────────────── Loadout gating ─────────────────────────

export interface SkinInfo {
  id: string;
  weaponDefIndex: number;
  slot: LoadoutSlot;
  minFloat: number;
  maxFloat: number;
  statTrakAvailable: boolean;
  souvenirAvailable: boolean;
  prices: readonly SkinPriceEntry[];
}

export interface LoadoutStickerInput {
  slotIndex: number;
  stickerId: string;
  wear: number;
  offsetX?: number | null;
  offsetY?: number | null;
  rotation?: number | null;
  scale?: number | null;
}

export interface LoadoutItemInput {
  slot: LoadoutSlot;
  weaponDefIndex: number;
  skinId: string | null;
  paintSeed: number;
  floatValue: number;
  statTrak: boolean;
  statTrakCount: number;
  souvenir: boolean;
  nameTag: string | null;
  stickers: readonly LoadoutStickerInput[];
  /** Charm on the weapon (needs at least skin level 1). */
  keychainId?: string | null;
}

export type LoadoutViolationCode =
  | 'CUSTOM_LOADOUTS_DISABLED'
  | 'SKIN_NOT_FOUND'
  | 'SKIN_WEAPON_MISMATCH'
  | 'SKIN_LEVEL_TOO_LOW'
  | 'FLOAT_OUT_OF_RANGE'
  | 'FLOAT_EDITING_DISABLED'
  | 'STICKER_CRAFTS_DISABLED'
  | 'STICKER_SLOT_INVALID'
  | 'STICKER_SLOT_DUPLICATE'
  | 'STICKER_WEAR_OUT_OF_RANGE'
  | 'PAINT_SEED_OUT_OF_RANGE'
  | 'STATTRAK_UNAVAILABLE'
  | 'SOUVENIR_UNAVAILABLE'
  | 'VARIANT_CONFLICT'
  | 'NAME_TAG_TOO_LONG'
  | 'DUPLICATE_WEAPON';

export interface LoadoutViolation {
  code: LoadoutViolationCode;
  itemIndex: number;
  message: string;
}

export interface LoadoutCheckContext {
  skins: ReadonlyMap<string, SkinInfo>;
  permission: EffectiveSkinPermission;
  thresholds?: SkinLevelThresholds;
}

/** All reasons an item cannot be used under the given permission. Empty array = allowed as is. */
export function checkLoadoutItem(
  item: LoadoutItemInput,
  itemIndex: number,
  context: LoadoutCheckContext,
): LoadoutViolation[] {
  const violations: LoadoutViolation[] = [];
  const add = (code: LoadoutViolationCode, message: string): void => {
    violations.push({ code, itemIndex, message });
  };
  const { permission } = context;
  const thresholds = context.thresholds ?? DEFAULT_SKIN_LEVEL_THRESHOLDS;

  if (!permission.customLoadouts) add('CUSTOM_LOADOUTS_DISABLED', 'Custom loadouts are disabled for this player');

  if (!isValidFloat(item.floatValue)) add('FLOAT_OUT_OF_RANGE', 'Float must be between 0 and 1');
  if (!Number.isInteger(item.paintSeed) || item.paintSeed < PAINT_SEED_MIN || item.paintSeed > PAINT_SEED_MAX) {
    add('PAINT_SEED_OUT_OF_RANGE', `Paint seed must be an integer between ${PAINT_SEED_MIN} and ${PAINT_SEED_MAX}`);
  }
  if (item.keychainId && permission.level < 1) add('SKIN_LEVEL_TOO_LOW', 'Charms need at least skin level 1');
  if (item.statTrak && item.souvenir) add('VARIANT_CONFLICT', 'An item cannot be both StatTrak and Souvenir');
  if (item.nameTag !== null && item.nameTag.length > NAME_TAG_MAX_LENGTH) {
    add('NAME_TAG_TOO_LONG', `Name tags are limited to ${NAME_TAG_MAX_LENGTH} characters`);
  }

  let skin: SkinInfo | undefined;
  if (item.skinId !== null) {
    skin = context.skins.get(item.skinId);
    if (!skin) {
      add('SKIN_NOT_FOUND', 'Unknown skin');
    } else {
      if (skin.weaponDefIndex !== item.weaponDefIndex || skin.slot !== item.slot) {
        add('SKIN_WEAPON_MISMATCH', 'Skin does not belong to this weapon');
      }
      if (item.statTrak && !skin.statTrakAvailable) add('STATTRAK_UNAVAILABLE', 'StatTrak is not available for this skin');
      if (item.souvenir && !skin.souvenirAvailable) add('SOUVENIR_UNAVAILABLE', 'Souvenir is not available for this skin');

      if (isValidFloat(item.floatValue)) {
        const variant: SkinVariant = item.statTrak ? 'STATTRAK' : item.souvenir ? 'SOUVENIR' : 'NORMAL';
        // Vanilla items (knives/gloves without finish) are priced without a wear bucket.
        const unwornOnly = skin.prices.length > 0 && skin.prices.every((p) => p.wear === 'NONE');
        const wear: SkinWear = unwornOnly ? 'NONE' : floatToWear(item.floatValue);
        const needed = requiredSkinLevel(resolveSkinPrice(skin.prices, wear, variant), thresholds);
        if (permission.level < needed) {
          add('SKIN_LEVEL_TOO_LOW', `This skin needs skin level ${needed} (you have ${permission.level})`);
        }
      }
    }
  } else if (permission.level < 1) {
    // Stickers on the default finish still count as a customisation: needs at least level 1.
    if (item.stickers.length > 0) add('SKIN_LEVEL_TOO_LOW', 'Customisation needs at least skin level 1');
  }

  if (!permission.floatEditing && isValidFloat(item.floatValue)) {
    const expected = skin ? defaultFloatFor(skin) : DEFAULT_FLOAT;
    if (Math.abs(item.floatValue - expected) > 1e-9) {
      add('FLOAT_EDITING_DISABLED', 'Float editing is disabled for this player');
    }
  }

  if (item.stickers.length > 0) {
    if (!permission.stickerCrafts) add('STICKER_CRAFTS_DISABLED', 'Sticker crafts are disabled for this player');
    const seen = new Set<number>();
    for (const sticker of item.stickers) {
      if (!Number.isInteger(sticker.slotIndex) || sticker.slotIndex < 0 || sticker.slotIndex >= STICKER_SLOT_COUNT) {
        add('STICKER_SLOT_INVALID', `Sticker slot must be 0–${STICKER_SLOT_COUNT - 1}`);
      } else if (seen.has(sticker.slotIndex)) {
        add('STICKER_SLOT_DUPLICATE', `Sticker slot ${sticker.slotIndex} is used twice`);
      }
      seen.add(sticker.slotIndex);
      if (!isValidFloat(sticker.wear)) add('STICKER_WEAR_OUT_OF_RANGE', 'Sticker wear must be between 0 and 1');
    }
  }

  return violations;
}

/** Validation for saving: every violation of every item, plus duplicate weapons. */
export function validateLoadout(items: readonly LoadoutItemInput[], context: LoadoutCheckContext): LoadoutViolation[] {
  const violations: LoadoutViolation[] = [];
  const weapons = new Set<number>();
  items.forEach((item, index) => {
    if (weapons.has(item.weaponDefIndex)) {
      violations.push({ code: 'DUPLICATE_WEAPON', itemIndex: index, message: 'Each weapon can appear once per loadout' });
    }
    weapons.add(item.weaponDefIndex);
    violations.push(...checkLoadoutItem(item, index, context));
  });
  return violations;
}

export interface AppliedLoadout {
  items: LoadoutItemInput[];
  skipped: Array<{ itemIndex: number; weaponDefIndex: number; reasons: LoadoutViolationCode[] }>;
}

/**
 * Evaluated again at the moment a server applies a loadout (permissions may have expired since saving):
 * items that violate the current permission are skipped, so a revoked player simply gets default skins.
 */
export function resolveLoadoutForApplication(
  items: readonly LoadoutItemInput[],
  context: LoadoutCheckContext,
): AppliedLoadout {
  const applied: LoadoutItemInput[] = [];
  const skipped: AppliedLoadout['skipped'] = [];
  const seen = new Set<number>();
  items.forEach((item, index) => {
    const violations = seen.has(item.weaponDefIndex)
      ? [{ code: 'DUPLICATE_WEAPON' as const, itemIndex: index, message: '' }]
      : checkLoadoutItem(item, index, context);
    seen.add(item.weaponDefIndex);
    if (violations.length === 0) applied.push(item);
    else skipped.push({ itemIndex: index, weaponDefIndex: item.weaponDefIndex, reasons: violations.map((v) => v.code) });
  });
  return { items: applied, skipped };
}
