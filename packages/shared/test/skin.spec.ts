import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLOAT,
  NO_SKIN_PERMISSION,
  effectiveSkinPermission,
  expiryFromPreset,
  floatToWear,
  isValidFloat,
  requiredSkinLevel,
  resolveLoadoutForApplication,
  resolveSkinPrice,
  validateLoadout,
  type EffectiveSkinPermission,
  type LoadoutItemInput,
  type SkinInfo,
  type SkinPermissionGrant,
} from '../src/index.js';

describe('float validation', () => {
  it.each([0, 0.0001, 0.12, 0.42, 0.999, 1])('accepts %s', (v) => expect(isValidFloat(v)).toBe(true));
  it.each([-0.0001, 1.0001, 2, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined])('rejects %s', (v) =>
    expect(isValidFloat(v)).toBe(false),
  );

  it('maps floats to wear buckets', () => {
    expect(floatToWear(0)).toBe('FACTORY_NEW');
    expect(floatToWear(0.0699)).toBe('FACTORY_NEW');
    expect(floatToWear(0.07)).toBe('MINIMAL_WEAR');
    expect(floatToWear(0.15)).toBe('FIELD_TESTED');
    expect(floatToWear(0.38)).toBe('WELL_WORN');
    expect(floatToWear(0.45)).toBe('BATTLE_SCARRED');
    expect(floatToWear(1)).toBe('BATTLE_SCARRED');
    expect(() => floatToWear(1.5)).toThrow(RangeError);
  });
});

describe('skin level by price', () => {
  it('uses strict "under" thresholds', () => {
    expect(requiredSkinLevel(0)).toBe(1);
    expect(requiredSkinLevel(249.99)).toBe(1);
    expect(requiredSkinLevel(250)).toBe(2);
    expect(requiredSkinLevel(999.99)).toBe(2);
    expect(requiredSkinLevel(1000)).toBe(3);
    expect(requiredSkinLevel(50000)).toBe(3);
  });

  it('treats unknown prices conservatively', () => {
    expect(requiredSkinLevel(null)).toBe(3);
    expect(requiredSkinLevel(undefined)).toBe(3);
    expect(requiredSkinLevel(Number.NaN)).toBe(3);
    expect(requiredSkinLevel(null, { level1MaxUsd: 250, level2MaxUsd: 1000, unknownPriceLevel: 1 })).toBe(1);
  });

  it('respects configured thresholds', () => {
    const t = { level1MaxUsd: 50, level2MaxUsd: 100, unknownPriceLevel: 3 as const };
    expect(requiredSkinLevel(49, t)).toBe(1);
    expect(requiredSkinLevel(50, t)).toBe(2);
    expect(requiredSkinLevel(100, t)).toBe(3);
  });

  it('resolves prices: exact combination first, otherwise the highest known', () => {
    const prices = [
      { wear: 'FACTORY_NEW', variant: 'NORMAL', priceUsd: 900 },
      { wear: 'FIELD_TESTED', variant: 'NORMAL', priceUsd: 120 },
      { wear: 'FIELD_TESTED', variant: 'STATTRAK', priceUsd: 300 },
    ] as const;
    expect(resolveSkinPrice(prices, 'FIELD_TESTED', 'NORMAL')).toBe(120);
    expect(resolveSkinPrice(prices, 'FIELD_TESTED', 'STATTRAK')).toBe(300);
    expect(resolveSkinPrice(prices, 'WELL_WORN', 'NORMAL')).toBe(900);
    expect(resolveSkinPrice([], 'WELL_WORN', 'NORMAL')).toBeNull();
  });
});

describe('temporary skin permissions', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const grant = (over: Partial<SkinPermissionGrant> = {}): SkinPermissionGrant => ({
    level: 2,
    stickerCrafts: true,
    floatEditing: true,
    customLoadouts: true,
    expiresAt: new Date('2026-10-02T14:00:00Z'),
    revokedAt: null,
    createdAt: new Date('2026-10-02T12:00:00Z'),
    ...over,
  });

  it('uses the default when there are no grants', () => {
    expect(effectiveSkinPermission([], now)).toEqual(NO_SKIN_PERMISSION);
  });

  it('applies an active grant', () => {
    const p = effectiveSkinPermission([grant()], now);
    expect(p).toMatchObject({ level: 2, stickerCrafts: true, floatEditing: true, source: 'grant' });
  });

  it('expires exactly at the expiry time', () => {
    const g = grant();
    expect(effectiveSkinPermission([g], new Date('2026-10-02T13:59:59.999Z')).level).toBe(2);
    expect(effectiveSkinPermission([g], new Date('2026-10-02T14:00:00.000Z')).level).toBe(0);
    expect(effectiveSkinPermission([g], new Date('2026-10-03T00:00:00Z')).source).toBe('default');
  });

  it('permanent grants never expire', () => {
    const g = grant({ expiresAt: null });
    expect(effectiveSkinPermission([g], new Date('2099-01-01T00:00:00Z')).level).toBe(2);
  });

  it('a revoked grant falls back to the default', () => {
    expect(effectiveSkinPermission([grant({ revokedAt: now })], now).source).toBe('default');
  });

  it('the newest grant wins and an expired newest never revives older ones', () => {
    const older = grant({ level: 3, expiresAt: null, createdAt: new Date('2026-10-01T00:00:00Z') });
    const newer = grant({ level: 1, expiresAt: new Date('2026-10-02T11:00:00Z'), createdAt: new Date('2026-10-02T10:00:00Z') });
    expect(effectiveSkinPermission([older, newer], now).level).toBe(0);
    expect(effectiveSkinPermission([older, newer], new Date('2026-10-02T10:30:00Z')).level).toBe(1);
  });

  it('honours a custom platform default', () => {
    const fallback: EffectiveSkinPermission = { ...NO_SKIN_PERMISSION, level: 1 };
    expect(effectiveSkinPermission([grant({ expiresAt: new Date('2026-10-02T11:00:00Z') })], now, fallback).level).toBe(1);
  });

  it('clamps out-of-range levels', () => {
    expect(effectiveSkinPermission([grant({ level: 9 })], now).level).toBe(3);
    expect(effectiveSkinPermission([grant({ level: -2 })], now).level).toBe(0);
  });

  it('computes expiry from presets', () => {
    expect(expiryFromPreset('15m', now)!.toISOString()).toBe('2026-10-02T12:15:00.000Z');
    expect(expiryFromPreset('2h', now)!.toISOString()).toBe('2026-10-02T14:00:00.000Z');
    expect(expiryFromPreset('1d', now)!.toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(expiryFromPreset('7d', now)!.toISOString()).toBe('2026-10-09T12:00:00.000Z');
    expect(expiryFromPreset('permanent', now)).toBeNull();
  });
});

describe('loadout validation', () => {
  const skins = new Map<string, SkinInfo>([
    [
      'redline',
      {
        id: 'redline', weaponDefIndex: 7, slot: 'RIFLE', minFloat: 0.1, maxFloat: 0.7,
        statTrakAvailable: true, souvenirAvailable: false,
        prices: [
          { wear: 'FIELD_TESTED', variant: 'NORMAL', priceUsd: 25 },
          { wear: 'MINIMAL_WEAR', variant: 'NORMAL', priceUsd: 60 },
        ],
      },
    ],
    [
      'fade-karambit',
      {
        id: 'fade-karambit', weaponDefIndex: 507, slot: 'KNIFE', minFloat: 0, maxFloat: 0.08,
        statTrakAvailable: true, souvenirAvailable: false,
        prices: [{ wear: 'FACTORY_NEW', variant: 'NORMAL', priceUsd: 2200 }],
      },
    ],
    [
      'mid-awp',
      {
        id: 'mid-awp', weaponDefIndex: 9, slot: 'AWP', minFloat: 0, maxFloat: 1,
        statTrakAvailable: false, souvenirAvailable: true,
        prices: [{ wear: 'FIELD_TESTED', variant: 'NORMAL', priceUsd: 480 }],
      },
    ],
    [
      'unpriced',
      {
        id: 'unpriced', weaponDefIndex: 4, slot: 'PISTOL', minFloat: 0, maxFloat: 1,
        statTrakAvailable: false, souvenirAvailable: false, prices: [],
      },
    ],
  ]);

  const perm = (over: Partial<EffectiveSkinPermission> = {}): EffectiveSkinPermission => ({
    level: 3, stickerCrafts: true, floatEditing: true, customLoadouts: true, expiresAt: null, source: 'grant', ...over,
  });

  const item = (over: Partial<LoadoutItemInput> = {}): LoadoutItemInput => ({
    slot: 'RIFLE', weaponDefIndex: 7, skinId: 'redline', paintSeed: 5, floatValue: 0.2,
    statTrak: false, statTrakCount: 0, souvenir: false, nameTag: null, stickers: [], ...over,
  });

  const codes = (items: LoadoutItemInput[], permission: EffectiveSkinPermission) =>
    validateLoadout(items, { skins, permission }).map((v) => v.code);

  it('accepts a cheap skin at level 1', () => {
    expect(codes([item()], perm({ level: 1 }))).toEqual([]);
  });

  it('level 1 cannot use a $480 skin, level 2 can, a $2200 knife needs level 3', () => {
    const awp = item({ slot: 'AWP', weaponDefIndex: 9, skinId: 'mid-awp' });
    const knife = item({ slot: 'KNIFE', weaponDefIndex: 507, skinId: 'fade-karambit', floatValue: 0.01 });
    expect(codes([awp], perm({ level: 1 }))).toContain('SKIN_LEVEL_TOO_LOW');
    expect(codes([awp], perm({ level: 2 }))).toEqual([]);
    expect(codes([knife], perm({ level: 2 }))).toContain('SKIN_LEVEL_TOO_LOW');
    expect(codes([knife], perm({ level: 3 }))).toEqual([]);
  });

  it('level 0 can use nothing priced', () => {
    expect(codes([item()], perm({ level: 0 }))).toContain('SKIN_LEVEL_TOO_LOW');
  });

  it('price depends on the wear implied by the float', () => {
    // Redline FT $25 (level 1) but MW $60 (still level 1); use a cheaper threshold to prove the wear lookup.
    const strict = { level1MaxUsd: 40, level2MaxUsd: 1000, unknownPriceLevel: 3 as const };
    const ft = validateLoadout([item({ floatValue: 0.2 })], { skins, permission: perm({ level: 1 }), thresholds: strict });
    const mw = validateLoadout([item({ floatValue: 0.1 })], { skins, permission: perm({ level: 1 }), thresholds: strict });
    expect(ft).toEqual([]);
    expect(mw.map((v) => v.code)).toContain('SKIN_LEVEL_TOO_LOW');
  });

  it('skins without a known price need the conservative level', () => {
    const unpriced = item({ slot: 'PISTOL', weaponDefIndex: 4, skinId: 'unpriced' });
    expect(codes([unpriced], perm({ level: 2 }))).toContain('SKIN_LEVEL_TOO_LOW');
    expect(codes([unpriced], perm({ level: 3 }))).toEqual([]);
  });

  it('rejects invalid floats', () => {
    for (const floatValue of [-0.1, 1.2, Number.NaN]) {
      expect(codes([item({ floatValue })], perm())).toContain('FLOAT_OUT_OF_RANGE');
    }
    expect(codes([item({ floatValue: 0 }), item({ weaponDefIndex: 9, slot: 'AWP', skinId: 'mid-awp', floatValue: 1 })], perm())).toEqual([]);
  });

  it('blocks float edits without the permission but allows the default float', () => {
    expect(codes([item({ floatValue: 0.3 })], perm({ floatEditing: false }))).toContain('FLOAT_EDITING_DISABLED');
    // default float is clamped into the skin's range (redline min 0.1)
    expect(codes([item({ floatValue: 0.1 })], perm({ floatEditing: false }))).toEqual([]);
    expect(DEFAULT_FLOAT).toBe(0.001);
  });

  it('blocks sticker crafts without the permission', () => {
    const withSticker = item({ stickers: [{ slotIndex: 0, stickerId: 's1', wear: 0 }] });
    expect(codes([withSticker], perm({ stickerCrafts: false }))).toContain('STICKER_CRAFTS_DISABLED');
    expect(codes([withSticker], perm({ stickerCrafts: true }))).toEqual([]);
  });

  it('validates sticker slots and wear', () => {
    const bad = item({
      stickers: [
        { slotIndex: 5, stickerId: 'a', wear: 0 },
        { slotIndex: 1, stickerId: 'b', wear: 0 },
        { slotIndex: 1, stickerId: 'c', wear: 2 },
      ],
    });
    const result = codes([bad], perm());
    expect(result).toContain('STICKER_SLOT_INVALID');
    expect(result).toContain('STICKER_SLOT_DUPLICATE');
    expect(result).toContain('STICKER_WEAR_OUT_OF_RANGE');
  });

  it('checks StatTrak/Souvenir availability and conflicts', () => {
    expect(codes([item({ souvenir: true })], perm())).toContain('SOUVENIR_UNAVAILABLE');
    expect(codes([item({ statTrak: true })], perm())).toEqual([]);
    expect(codes([item({ statTrak: true, souvenir: true })], perm())).toContain('VARIANT_CONFLICT');
    const awp = item({ slot: 'AWP', weaponDefIndex: 9, skinId: 'mid-awp', statTrak: true });
    expect(codes([awp], perm())).toContain('STATTRAK_UNAVAILABLE');
  });

  it('rejects wrong weapon/skin combinations, unknown skins and duplicates', () => {
    expect(codes([item({ weaponDefIndex: 9, slot: 'AWP' })], perm())).toContain('SKIN_WEAPON_MISMATCH');
    expect(codes([item({ skinId: 'nope' })], perm())).toContain('SKIN_NOT_FOUND');
    expect(codes([item(), item()], perm())).toContain('DUPLICATE_WEAPON');
  });

  it('enforces the custom-loadouts switch, seeds and name tags', () => {
    expect(codes([item()], perm({ customLoadouts: false }))).toContain('CUSTOM_LOADOUTS_DISABLED');
    expect(codes([item({ paintSeed: 1001 })], perm())).toContain('PAINT_SEED_OUT_OF_RANGE');
    expect(codes([item({ paintSeed: 1.5 })], perm())).toContain('PAINT_SEED_OUT_OF_RANGE');
    expect(codes([item({ nameTag: 'x'.repeat(21) })], perm())).toContain('NAME_TAG_TOO_LONG');
  });

  it('on application, expired permissions silently drop items instead of failing the match', () => {
    const items = [
      item(),
      item({ slot: 'KNIFE', weaponDefIndex: 507, skinId: 'fade-karambit', floatValue: 0.01 }),
    ];
    const result = resolveLoadoutForApplication(items, { skins, permission: perm({ level: 1 }) });
    expect(result.items.map((i) => i.weaponDefIndex)).toEqual([7]);
    expect(result.skipped).toEqual([{ itemIndex: 1, weaponDefIndex: 507, reasons: ['SKIN_LEVEL_TOO_LOW'] }]);

    const none = resolveLoadoutForApplication(items, { skins, permission: { ...NO_SKIN_PERMISSION } });
    expect(none.items).toEqual([]);
    expect(none.skipped).toHaveLength(2);
  });
});
