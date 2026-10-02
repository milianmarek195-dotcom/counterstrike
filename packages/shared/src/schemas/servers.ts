import { z } from 'zod';

const host = z.union([
  z.ipv4(),
  z.ipv6(),
  z
    .string()
    .max(253)
    .regex(/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, 'must be an IP address or hostname'),
]);

export const createServerSchema = z.object({
  name: z.string().trim().min(1).max(64),
  ip: host,
  port: z.number().int().min(1).max(65535),
  region: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,16}$/, 'short region code, e.g. eu, eu-west, na'),
  maxPlayers: z.number().int().min(2).max(64).default(12),
});
export type CreateServerInput = z.infer<typeof createServerSchema>;

export const updateServerSchema = createServerSchema.partial().extend({
  enabled: z.boolean().optional(),
  /** Takes the server out of the allocation pool without disabling it (status shows ONLINE). */
  maintenanceHold: z.boolean().optional(),
  /** Allows the skin-changer module on this server (it still needs `Skins.Enabled` in the plugin config). */
  skinsEnabled: z.boolean().optional(),
});
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
