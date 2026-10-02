import { z } from 'zod';

/**
 * Wire contract between the CS2 plugin (or mock server) and the backend gateway.
 * These schemas are the single definition: the API validates with them, the mock server builds payloads from them,
 * and docs/PLUGIN.md is generated from the same field list.
 */

export const steamId64Schema = z.string().regex(/^7656119\d{10}$/, 'must be a SteamID64');
const teamSlotSchema = z.enum(['A', 'B']);
const count = z.number().int().min(0).max(100_000);
const isoTimestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export const SERVER_REPORTED_STATUSES = ['STARTING', 'READY', 'IN_USE', 'ERROR'] as const;

export const heartbeatSchema = z.object({
  status: z.enum(SERVER_REPORTED_STATUSES),
  currentMatchId: z.uuid().nullable(),
  players: z.number().int().min(0).max(128),
  version: z.string().min(1).max(32),
  gameVersion: z.string().max(32).optional(),
  timestampMs: z.number().int().positive(),
  health: z
    .object({
      map: z.string().max(64),
      tickrate: z.number().min(0).max(1000),
      cpuLoad: z.number().min(0).max(1000),
      memoryMb: z.number().min(0).max(1_000_000),
      uptimeSeconds: z.number().int().min(0),
    })
    .partial()
    .optional(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatSchema>;

const eventBase = {
  seq: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(128),
  /** Milliseconds since epoch on the game server. */
  at: z.number().int().positive(),
  matchId: z.uuid().nullable(),
};

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('player.connected'), steamId: steamId64Schema }),
  z.object({ ...eventBase, type: z.literal('player.disconnected'), steamId: steamId64Schema }),
  z.object({ ...eventBase, type: z.literal('player.rejected'), steamId: steamId64Schema, reason: z.string().max(120) }),
  z.object({ ...eventBase, type: z.literal('match.configured') }),
  z.object({ ...eventBase, type: z.literal('map.started'), mapNumber: z.number().int().min(1).max(5) }),
  z.object({
    ...eventBase,
    type: z.literal('round.ended'),
    mapNumber: z.number().int().min(1).max(5),
    scoreA: count.max(200),
    scoreB: count.max(200),
  }),
  z.object({ ...eventBase, type: z.literal('match.paused'), team: teamSlotSchema.nullable(), reason: z.string().max(120).optional() }),
  z.object({ ...eventBase, type: z.literal('match.unpaused') }),
  z.object({
    ...eventBase,
    type: z.literal('penalty.team_damage'),
    steamId: steamId64Schema,
    reason: z.string().max(200),
  }),
  z.object({ ...eventBase, type: z.literal('server.error'), message: z.string().max(300) }),
]);
export type ServerEventPayload = z.infer<typeof serverEventSchema>;
export type ServerEventType = ServerEventPayload['type'];

export const eventBatchSchema = z.object({ events: z.array(serverEventSchema).min(1).max(100) });

export const playerMapStatsSchema = z.object({
  steamId: steamId64Schema,
  team: teamSlotSchema,
  rounds: count.max(200),
  kills: count,
  deaths: count,
  assists: count,
  headshots: count,
  damage: count.max(1_000_000),
  mvps: count,
  flashAssists: count.default(0),
  utilityDamage: count.max(1_000_000).default(0),
  clutches: count.default(0),
  entryKills: count.default(0),
  entryDeaths: count.default(0),
});
export type PlayerMapStatsPayload = z.infer<typeof playerMapStatsSchema>;

export const END_REASONS = ['NORMAL', 'FORFEIT', 'ADMIN'] as const;

export const mapResultSchema = z.object({
  matchId: z.uuid(),
  mapNumber: z.number().int().min(1).max(5),
  /** Same key on every retry of the same result; the backend deduplicates on it. */
  idempotencyKey: z.string().min(8).max(128),
  scoreA: count.max(200),
  scoreB: count.max(200),
  rounds: count.max(400),
  startedAt: isoTimestamp,
  endedAt: isoTimestamp,
  endReason: z.enum(END_REASONS).default('NORMAL'),
  players: z.array(playerMapStatsSchema).min(1).max(24),
});
export type MapResultPayload = z.infer<typeof mapResultSchema>;
export type MapResultInput = z.input<typeof mapResultSchema>;

export const commandAckSchema = z.object({
  status: z.enum(['ACKED', 'FAILED']),
  reason: z.string().max(300).optional(),
});

export const playerAuthorizeSchema = z.object({ steamId: steamId64Schema });

export const commandsQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(25).default(0),
});

export const skinCommandSchema = z.object({
  actorSteamId: steamId64Schema,
  /** SteamID64 of the target, or "all" for every player on the server. */
  target: z.union([steamId64Schema, z.literal('all')]),
  level: z.number().int().min(0).max(3),
  /** Minutes; omit for permanent. */
  durationMinutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
});

export const teamDamageBanSchema = z.object({
  steamId: steamId64Schema,
  matchId: z.uuid(),
  reason: z.string().max(200),
});
