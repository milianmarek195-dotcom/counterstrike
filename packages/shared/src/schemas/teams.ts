import { z } from 'zod';
import { GAME_MODES } from '../constants.js';
import { steamId64Schema } from './server-gateway.js';

export const TEAM_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{1,38}[\p{L}\p{N}]$/u;

export const createTeamSchema = z.object({
  name: z.string().trim().regex(TEAM_NAME_PATTERN, 'Name must be 3–40 characters (letters, numbers, space . _ \' -)'),
  tag: z.string().trim().regex(/^[A-Za-z0-9]{2,6}$/, 'Tag must be 2–6 letters or digits').optional(),
  mode: z.enum(GAME_MODES).default('FIVE_V_FIVE'),
});

export const updateTeamSchema = z.object({
  name: createTeamSchema.shape.name.optional(),
  tag: createTeamSchema.shape.tag.or(z.null()).optional(),
});

export const inviteToTeamSchema = z
  .object({ userId: z.uuid().optional(), steamId: steamId64Schema.optional() })
  .refine((v) => v.userId || v.steamId, { message: 'userId or steamId is required' });

export const teamListQuerySchema = z.object({
  q: z.string().trim().max(40).optional(),
  mode: z.enum(GAME_MODES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
