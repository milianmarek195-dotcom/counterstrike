import { z } from 'zod';
import { LOADOUT_SLOTS } from '../constants.js';
import {
  DEFAULT_FLOAT,
  FLOAT_MAX,
  FLOAT_MIN,
  NAME_TAG_MAX_LENGTH,
  PAINT_SEED_MAX,
  PAINT_SEED_MIN,
  SKIN_DURATION_PRESETS,
  STICKER_SLOT_COUNT,
  MAX_CUSTOM_DURATION_MS,
} from '../skin.js';

/**
 * Float: any number from 0 to 1 (e.g. 0.012345). Pattern / paint seed: an INTEGER 0–1000 – "661" is valid, "661.42" and
 * negative values are rejected, both here and again by a database CHECK constraint.
 */
export const floatSchema = z.number().min(FLOAT_MIN).max(FLOAT_MAX);
export const paintSeedSchema = z
  .number()
  .int('The pattern must be a whole number')
  .min(PAINT_SEED_MIN, 'The pattern cannot be negative')
  .max(PAINT_SEED_MAX, `The pattern is at most ${PAINT_SEED_MAX}`);

export const stickerPlacementSchema = z.object({
  stickerId: z.uuid(),
  slotIndex: z.number().int().min(0).max(STICKER_SLOT_COUNT - 1),
  wear: floatSchema.default(0),
  offsetX: z.number().min(-1).max(1).nullish(),
  offsetY: z.number().min(-1).max(1).nullish(),
  rotation: z.number().min(-360).max(360).nullish(),
  scale: z.number().min(0.1).max(3).nullish(),
});

/** One saved skin of the virtual inventory: weapon, paint kit, float, pattern, StatTrak/Souvenir, stickers. */
export const inventoryItemInputSchema = z
  .object({
    slot: z.enum(LOADOUT_SLOTS),
    weaponDefIndex: z.number().int().min(1).max(100_000),
    /** null = default finish of the weapon (e.g. only stickers). */
    skinId: z.uuid().nullable().default(null),
    floatValue: floatSchema.default(DEFAULT_FLOAT),
    paintSeed: paintSeedSchema.default(0),
    statTrak: z.boolean().default(false),
    statTrakCount: z.number().int().min(0).max(999_999).default(0),
    souvenir: z.boolean().default(false),
    nameTag: z.string().trim().max(NAME_TAG_MAX_LENGTH).nullish().transform((v) => (v ? v : null)),
    stickers: z.array(stickerPlacementSchema).max(STICKER_SLOT_COUNT).default([]),
  })
  .refine((v) => !(v.statTrak && v.souvenir), { message: 'An item cannot be StatTrak and Souvenir', path: ['souvenir'] })
  .refine((v) => new Set(v.stickers.map((s) => s.slotIndex)).size === v.stickers.length, { message: 'A sticker slot is used twice', path: ['stickers'] });
export type InventoryItemInput = z.infer<typeof inventoryItemInputSchema>;

export const skinSearchQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  slot: z.enum(LOADOUT_SLOTS).optional(),
  weaponDefIndex: z.coerce.number().int().positive().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
});

export const stickerSearchQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(40),
});

export const loadoutNameSchema = z.string().trim().min(1).max(40);

export const createLoadoutSchema = z.object({ name: loadoutNameSchema });
export const updateLoadoutSchema = z.object({
  name: loadoutNameSchema.optional(),
  visibility: z.enum(['PRIVATE', 'UNLISTED', 'PUBLIC']).optional(),
});
/** Which inventory item is used for which weapon in a loadout (one per weapon). */
export const setLoadoutItemsSchema = z.object({
  items: z.array(z.object({ inventoryItemId: z.uuid() })).max(40),
});
export const importLoadoutCodeSchema = z.object({ code: z.string().trim().min(6).max(24), name: loadoutNameSchema.optional() });

/** Portable export: references skins by (weaponDefIndex, paintIndex), never by database id, so it works on any installation. */
export const loadoutExportSchema = z.object({
  format: z.literal('celtist-loadout'),
  version: z.literal(1),
  name: loadoutNameSchema,
  items: z
    .array(
      z.object({
        slot: z.enum(LOADOUT_SLOTS),
        weaponDefIndex: z.number().int().positive(),
        paintIndex: z.number().int().min(0).nullable(),
        floatValue: floatSchema,
        paintSeed: paintSeedSchema,
        statTrak: z.boolean().default(false),
        statTrakCount: z.number().int().min(0).default(0),
        souvenir: z.boolean().default(false),
        nameTag: z.string().max(NAME_TAG_MAX_LENGTH).nullable().default(null),
        stickers: z
          .array(z.object({ stickerDefIndex: z.number().int().positive(), slotIndex: z.number().int().min(0).max(STICKER_SLOT_COUNT - 1), wear: floatSchema.default(0), offsetX: z.number().nullish(), offsetY: z.number().nullish(), rotation: z.number().nullish(), scale: z.number().nullish() }))
          .max(STICKER_SLOT_COUNT)
          .default([]),
      }),
    )
    .max(40),
});
export type LoadoutExport = z.infer<typeof loadoutExportSchema>;
export const importLoadoutJsonSchema = z.object({ data: loadoutExportSchema });

const presetKeys: [string, ...string[]] = ['15m', ...SKIN_DURATION_PRESETS.map((p) => p.key as string).filter((k) => k !== '15m'), 'custom'];

/** Admin grants skin access: level, optional features and an expiry (preset or custom minutes). */
export const grantSkinPermissionSchema = z
  .object({
    userId: z.uuid(),
    level: z.number().int().min(0).max(3),
    stickerCrafts: z.boolean().default(false),
    floatEditing: z.boolean().default(false),
    customLoadouts: z.boolean().default(true),
    duration: z.enum(presetKeys).default('permanent'),
    customMinutes: z.number().int().min(1).max(Math.floor(MAX_CUSTOM_DURATION_MS / 60_000)).optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.duration !== 'custom' || v.customMinutes !== undefined, { message: 'customMinutes is required for a custom duration', path: ['customMinutes'] });
export type GrantSkinPermissionInput = z.infer<typeof grantSkinPermissionSchema>;
