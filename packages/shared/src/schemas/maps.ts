import { z } from 'zod';
import { BEST_OF_VALUES, GAME_MODES } from '../constants.js';

const gameMode = z.enum(GAME_MODES);

export const mapKeySchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'engine name, lower case letters, digits and underscores (e.g. de_mirage)');

export const createMapSchema = z.object({
  key: mapKeySchema,
  name: z.string().trim().min(1).max(64),
  imageUrl: z.url({ protocol: /^https$/ }).max(500).nullish(),
  workshopId: z.string().regex(/^\d{1,20}$/).nullish(),
  modes: z.array(gameMode).min(1).max(2),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(10_000).default(100),
});
export type CreateMapInput = z.infer<typeof createMapSchema>;

export const updateMapSchema = createMapSchema.omit({ key: true }).partial();
export type UpdateMapInput = z.infer<typeof updateMapSchema>;

export const createMapPoolSchema = z.object({
  name: z.string().trim().min(1).max(64),
  mode: gameMode.nullish(),
  isDefault: z.boolean().default(false),
  mapIds: z.array(z.uuid()).min(1).max(30),
});
export type CreateMapPoolInput = z.infer<typeof createMapPoolSchema>;

export const updateMapPoolSchema = createMapPoolSchema.partial();

export const vetoStepSchema = z.object({
  action: z.enum(['BAN', 'PICK', 'SIDE', 'DECIDER']),
  team: z.enum(['A', 'B']).optional(),
});

export const createVetoTemplateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  bestOf: z.union(BEST_OF_VALUES.map((v) => z.literal(v)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<5>]),
  steps: z.array(vetoStepSchema).min(1).max(40),
  isDefault: z.boolean().default(false),
});
export type CreateVetoTemplateInput = z.infer<typeof createVetoTemplateSchema>;
export const updateVetoTemplateSchema = createVetoTemplateSchema.partial();
