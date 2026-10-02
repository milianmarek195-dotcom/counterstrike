import { z } from 'zod';
import {
  BEST_OF_VALUES,
  DEFAULT_TEAM_SIZE,
  GAME_MODES,
  MAX_TEAM_SIZE,
  SUPPORTED_TOURNAMENT_FORMATS,
  TEAM_SIZE_BY_MODE,
  isGameModeEnabled,
  type GameMode,
} from '../constants.js';

const bestOf = z.union(BEST_OF_VALUES.map((v) => z.literal(v)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<5>]);
const format = z.enum(SUPPORTED_TOURNAMENT_FORMATS as unknown as [string, ...string[]]);

export const createTournamentSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    description: z.string().trim().max(4000).nullish(),
    rules: z.string().trim().max(8000).nullish(),
    format,
    mode: z.enum(GAME_MODES).default('FIVE_V_FIVE'),
    /** Expected players per team (a default: admins can still adjust the actual line-up of single matches). */
    teamSize: z.number().int().min(1).max(MAX_TEAM_SIZE).default(DEFAULT_TEAM_SIZE),
    maxTeams: z.number().int().min(2).max(256),
    minTeams: z.number().int().min(2).max(256).default(2),
    bestOf: bestOf.default(1),
    bestOfFinal: bestOf.nullish(),
    grandFinalReset: z.boolean().default(true),
    thirdPlaceMatch: z.boolean().default(false),
    seedingMethod: z.enum(['ELO', 'RANDOM', 'MANUAL']).default('ELO'),
    visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PUBLIC'),
    registrationOpen: z.boolean().default(false),
    allowSubstitutes: z.boolean().default(true),
    substitutesPerTeam: z.number().int().min(0).max(3).default(1),
    minElo: z.number().int().min(0).max(10_000).nullish(),
    maxElo: z.number().int().min(0).max(10_000).nullish(),
    password: z.string().min(4).max(64).nullish(),
    startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    mapPoolId: z.uuid().optional(),
    vetoTemplateId: z.uuid().nullish(),
    serverIds: z.array(z.uuid()).max(50).default([]),
  })
  .superRefine((t, ctx) => {
    if (!isGameModeEnabled(t.mode)) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'Wingman cups are coming soon' });
    if (t.minTeams > t.maxTeams) ctx.addIssue({ code: 'custom', path: ['minTeams'], message: 'minTeams must not exceed maxTeams' });
    if (t.minElo != null && t.maxElo != null && t.minElo > t.maxElo) ctx.addIssue({ code: 'custom', path: ['minElo'], message: 'minElo must not exceed maxElo' });
    if (t.format === 'DOUBLE_ELIMINATION' && t.minTeams < 3) ctx.addIssue({ code: 'custom', path: ['minTeams'], message: 'Double elimination needs at least 3 teams' });
  });
export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;

export const updateTournamentSchema = z.object({
  name: z.string().trim().min(3).max(80).optional(),
  description: z.string().trim().max(4000).nullish(),
  rules: z.string().trim().max(8000).nullish(),
  maxTeams: z.number().int().min(2).max(256).optional(),
  minTeams: z.number().int().min(2).max(256).optional(),
  bestOf: bestOf.optional(),
  bestOfFinal: bestOf.nullish(),
  seedingMethod: z.enum(['ELO', 'RANDOM', 'MANUAL']).optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  registrationOpen: z.boolean().optional(),
  allowSubstitutes: z.boolean().optional(),
  substitutesPerTeam: z.number().int().min(0).max(3).optional(),
  minElo: z.number().int().min(0).max(10_000).nullish(),
  maxElo: z.number().int().min(0).max(10_000).nullish(),
  password: z.string().min(4).max(64).nullish(),
  startsAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  mapPoolId: z.uuid().optional(),
  vetoTemplateId: z.uuid().nullish(),
  serverIds: z.array(z.uuid()).max(50).optional(),
});
export type UpdateTournamentInput = z.infer<typeof updateTournamentSchema>;

export const tournamentListQuerySchema = z.object({
  status: z.enum(['upcoming', 'running', 'finished']).optional(),
  mode: z.enum(GAME_MODES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const registerSchema = z.object({
  password: z.string().max(64).optional(),
  /** Register a whole team (captain only) instead of yourself. */
  teamId: z.uuid().optional(),
});

export const adminAddTeamSchema = z.object({
  name: z.string().trim().min(1).max(40),
  teamId: z.uuid().optional(),
  members: z
    .array(z.object({ userId: z.uuid(), role: z.enum(['CAPTAIN', 'MEMBER', 'SUBSTITUTE']).default('MEMBER') }))
    .min(1)
    .max(8),
});

export const adminEditTeamSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  seed: z.number().int().min(1).max(256).nullish(),
  status: z.enum(['PENDING', 'CONFIRMED', 'DISQUALIFIED', 'WITHDRAWN']).optional(),
  members: z
    .array(z.object({ userId: z.uuid(), role: z.enum(['CAPTAIN', 'MEMBER', 'SUBSTITUTE']).default('MEMBER') }))
    .min(1)
    .max(8)
    .optional(),
});

export const autoAssignSchema = z.object({ strategy: z.enum(['BALANCED', 'RANDOM']).default('BALANCED') });

export const assignPlayersSchema = z.object({
  teams: z
    .array(z.object({ name: z.string().trim().min(1).max(40), userIds: z.array(z.uuid()).min(1).max(8) }))
    .min(1)
    .max(256),
});

export function teamSizeFor(mode: GameMode): number {
  return TEAM_SIZE_BY_MODE[mode];
}
