import { z } from 'zod';
import { BEST_OF_VALUES, GAME_MODES, STARTING_SIDES } from '../constants.js';
// GAME_MODES stays for list filters; creating matches never takes a mode (Wingman is coming soon).

const reason = z.string().trim().min(3).max(300);

export const vetoActionSchema = z.object({
  action: z.enum(['BAN', 'PICK', 'SIDE']),
  mapId: z.uuid().optional(),
  side: z.enum(STARTING_SIDES).optional(),
});
export type VetoActionInput = z.infer<typeof vetoActionSchema>;

/** Optional note for controller actions (party leaders are not forced to write a justification, admins may). */
const optionalReason = z.string().trim().max(300).optional();

export const controlReasonSchema = z.object({ reason: optionalReason });

/** Forces the map for a map slot of the match; overrides any veto. The backend checks pool, state and rights. */
export const forceMapSchema = z.object({
  mapId: z.uuid(),
  mapNumber: z.number().int().min(1).max(5).default(1),
  reason: optionalReason,
});
export type ForceMapInput = z.infer<typeof forceMapSchema>;

/** Moves a player between TEAM A, TEAM B and UNASSIGNED (team = null). */
export const assignTeamSchema = z.object({
  userId: z.uuid(),
  team: z.enum(['A', 'B']).nullable(),
  reason: optionalReason,
});

export const addPlayerSchema = z.object({
  userId: z.uuid().optional(),
  steamId: z.string().regex(/^7656119\d{10}$/).optional(),
  team: z.enum(['A', 'B']).nullable().default(null),
  reason: optionalReason,
}).refine((v) => v.userId || v.steamId, { message: 'userId or steamId is required' });

export const removeMatchPlayerSchema = z.object({ userId: z.uuid(), reason: optionalReason });

/** Match configuration the controller may change while the match is still being set up. */
export const updateMatchConfigSchema = z.object({
  bestOf: z.union(BEST_OF_VALUES.map((v) => z.literal(v)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<5>]).optional(),
  mapPoolId: z.uuid().optional(),
  teamAMax: z.number().int().min(1).max(16).optional(),
  teamBMax: z.number().int().min(1).max(16).optional(),
  teamAName: z.string().trim().min(1).max(40).optional(),
  teamBName: z.string().trim().min(1).max(40).optional(),
  reason: optionalReason,
});
export type UpdateMatchConfigInput = z.infer<typeof updateMatchConfigSchema>;

/** A party leader opens a match for their party: team sizes are chosen per side. */
export const createPartyMatchSchema = z.object({
  bestOf: z.union(BEST_OF_VALUES.map((v) => z.literal(v)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<5>]).default(1),
  teamAMax: z.number().int().min(1).max(16).default(5),
  teamBMax: z.number().int().min(1).max(16).default(5),
  teamAName: z.string().trim().min(1).max(40).default('Team A'),
  teamBName: z.string().trim().min(1).max(40).default('Team B'),
  mapPoolId: z.uuid().optional(),
});
export type CreatePartyMatchInput = z.infer<typeof createPartyMatchSchema>;

export const matchListQuerySchema = z.object({
  status: z.enum(['upcoming', 'live', 'finished']).optional(),
  tournamentId: z.uuid().optional(),
  steamId: z.string().regex(/^7656119\d{10}$/).optional(),
  mode: z.enum(GAME_MODES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type MatchListQuery = z.infer<typeof matchListQuerySchema>;

export const adminReasonSchema = z.object({ reason });

export const adminForceTeamSchema = z.object({
  userId: z.uuid(),
  team: z.enum(['A', 'B']),
  isSubstitute: z.boolean().default(false),
  reason,
});

export const adminRemovePlayerSchema = z.object({ userId: z.uuid(), reason });

export const adminPardonSchema = z.object({ userId: z.uuid(), reason });

export const adminBanFromMatchSchema = z.object({ userId: z.uuid(), reason });

export const adminEditScoreSchema = z.object({
  mapNumber: z.number().int().min(1).max(5),
  scoreA: z.number().int().min(0).max(200),
  scoreB: z.number().int().min(0).max(200),
  reason,
});

export const adminChangeMapSchema = z.object({ mapNumber: z.number().int().min(1).max(5), mapId: z.uuid(), reason });

export const adminAssignServerSchema = z.object({ serverId: z.uuid(), reason });

export const adminDecideSchema = z.object({ winner: z.enum(['A', 'B']), reason });

/** Admin creates a match directly with a roster (any team sizes). */
export const createCustomMatchSchema = z.object({
  bestOf: z.union(BEST_OF_VALUES.map((v) => z.literal(v)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<5>]).default(1),
  mapPoolId: z.uuid().optional(),
  teamA: z.object({ name: z.string().trim().min(1).max(40), maxPlayers: z.number().int().min(1).max(16), userIds: z.array(z.uuid()).max(16) }),
  teamB: z.object({ name: z.string().trim().min(1).max(40), maxPlayers: z.number().int().min(1).max(16), userIds: z.array(z.uuid()).max(16) }),
  unassignedUserIds: z.array(z.uuid()).max(32).default([]),
  controllerUserId: z.uuid().optional(),
});
export type CreateCustomMatchInput = z.infer<typeof createCustomMatchSchema>;
