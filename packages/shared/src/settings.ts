import { z } from 'zod';
import { DEFAULT_ELO_CONFIG } from './elo.js';
import { DEFAULT_SKIN_LEVEL_THRESHOLDS } from './skin.js';

/**
 * Operational parameters that live in the database (PlatformSetting) and can be changed in the admin
 * panel without a deployment. Every key has a Zod schema (validated on write and on read) and a default.
 */
const eloConfigSchema = z.object({
  startElo: z.number().int().min(0).max(5000),
  floor: z.number().int().min(0).max(5000),
  scale: z.number().min(50).max(2000),
  placementMatches: z.number().int().min(0).max(100),
  kPlacement: z.number().min(1).max(100),
  kDefault: z.number().min(1).max(100),
  kHighElo: z.number().min(1).max(100),
  highEloThreshold: z.number().int().min(0).max(10_000),
});

const skinThresholdsSchema = z
  .object({
    level1MaxUsd: z.number().positive().max(1_000_000),
    level2MaxUsd: z.number().positive().max(1_000_000),
    unknownPriceLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .refine((v) => v.level1MaxUsd < v.level2MaxUsd, { message: 'level1MaxUsd must be below level2MaxUsd' });

const matchmakingSchema = z.object({
  baseWindow: z.number().int().min(10).max(1000),
  expandStep: z.number().int().min(0).max(500),
  expandEverySeconds: z.number().int().min(1).max(600),
  maxWindow: z.number().int().min(10).max(5000),
});

export const SETTINGS = {
  'elo.config': { schema: eloConfigSchema, default: { ...DEFAULT_ELO_CONFIG } },
  'elo.rateForfeits': { schema: z.boolean(), default: false },
  'skin.thresholds': { schema: skinThresholdsSchema, default: { ...DEFAULT_SKIN_LEVEL_THRESHOLDS } },
  'skin.defaultLevel': { schema: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), default: 0 as 0 | 1 | 2 | 3 },
  /** Skin access every new account gets at its first login (and existing accounts that never had any). */
  'skin.welcomeGrant': {
    schema: z.object({ enabled: z.boolean(), level: z.number().int().min(0).max(3), days: z.number().int().min(1).max(3650), floatEditing: z.boolean(), stickerCrafts: z.boolean() }),
    default: { enabled: true, level: 2, days: 60, floatEditing: true, stickerCrafts: false },
  },
  /** Hard cap of three loadouts per player; admins may lower it but never raise it above 3. */
  'skin.maxLoadoutsPerUser': { schema: z.number().int().min(1).max(3), default: 3 },
  'skin.maxInventoryItems': { schema: z.number().int().min(1).max(500), default: 100 },
  'veto.stepTimeoutSeconds': { schema: z.number().int().min(10).max(600), default: 60 },
  /** A match never runs longer than this (minutes, 0 = no limit): party matches are ended, tournament matches decided by the score. */
  'match.maxDurationMinutes': { schema: z.number().int().min(0).max(600), default: 90 },
  /** Pauses each team may call per match and the longest a pause may last (plugin enforces, backend stores). */
  'match.pausesPerTeam': { schema: z.number().int().min(0).max(10), default: 2 },
  'match.pauseMaxSeconds': { schema: z.number().int().min(30).max(900), default: 180 },
  /** Team-damage penalty inside a match (never touches Valve's own cooldowns): kills / damage before removal. */
  'match.teamKillLimit': { schema: z.number().int().min(0).max(20), default: 3 },
  'match.teamDamageLimit': { schema: z.number().int().min(0).max(5000), default: 600 },
  'matchmaking.config': { schema: matchmakingSchema, default: { baseWindow: 100, expandStep: 50, expandEverySeconds: 15, maxWindow: 400 } },
  'tournament.maxActivePerAdmin': { schema: z.number().int().min(1).max(100), default: 20 },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return key in SETTINGS;
}

export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  return structuredClone(SETTINGS[key].default) as SettingValue<K>;
}

/** Parses a stored value; invalid or missing values fall back to the default so a bad row never breaks the platform. */
export function parseSetting<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
  if (stored === undefined || stored === null) return settingDefault(key);
  const result = (SETTINGS[key].schema as z.ZodType).safeParse(stored);
  return result.success ? (result.data as SettingValue<K>) : settingDefault(key);
}

/** Strict validation for writes (admin panel). */
export function validateSetting(key: SettingKey, value: unknown): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  const result = (SETTINGS[key].schema as z.ZodType).safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`) };
}
