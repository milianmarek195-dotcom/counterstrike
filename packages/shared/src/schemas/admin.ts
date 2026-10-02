import { z } from 'zod';
import { GAME_MODES } from '../constants.js';
import { PERMISSIONS } from '../permissions.js';

const reason = z.string().trim().min(3).max(300);

export const adminPlayerSearchSchema = z.object({
  q: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const setEloSchema = z.object({ mode: z.enum(GAME_MODES).default('FIVE_V_FIVE'), elo: z.number().int().min(0).max(5000), reason });
export const setRankSchema = z.object({ mode: z.enum(GAME_MODES).default('FIVE_V_FIVE'), tierKey: z.string().min(1).max(32), reason });

export const createBanSchema = z.object({
  userId: z.uuid(),
  reason,
  /** Hours; omit for a permanent ban. */
  durationHours: z.number().int().min(1).max(24 * 365 * 10).optional(),
});
export const unbanSchema = z.object({ reason });

export const createRoleSchema = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,38}$/, 'lower case letters, digits and underscores'),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).optional(),
  permissions: z.array(z.enum([...PERMISSIONS, '*'] as [string, ...string[]])).max(100),
});
export const updateRoleSchema = createRoleSchema.omit({ key: true }).partial();
export const setUserRolesSchema = z.object({ roleKeys: z.array(z.string().min(1).max(40)).max(10), reason });

export const auditQuerySchema = z.object({
  actorId: z.uuid().optional(),
  action: z.string().trim().max(80).optional(),
  targetType: z.string().trim().max(40).optional(),
  targetId: z.string().trim().max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const setSettingSchema = z.object({ value: z.unknown() });

export const rankTiersSchema = z.object({
  tiers: z
    .array(z.object({ key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,31}$/), name: z.string().trim().min(1).max(32), minElo: z.number().int().min(0).max(10_000), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }))
    .min(1)
    .max(20),
});

export const WEBHOOK_EVENTS = ['tournament.created', 'match.started', 'match.finished', 'tournament.finished', 'server.offline'] as const;
export const webhookSchema = z.object({
  name: z.string().trim().min(1).max(64),
  url: z.url({ protocol: /^https$/ }).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().default(true),
});
export const updateWebhookSchema = webhookSchema.partial();
