import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const emptyToUndefined = (value: unknown): unknown => (typeof value === 'string' && value.trim() === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const secret = z.string().min(32, 'must be at least 32 characters');

const encryptionKey = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be base64 of exactly 32 bytes (generate with scripts/generate-secrets.mjs)' },
);

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    APP_ROLE: z.enum(['all', 'http', 'worker']).default('all'),

    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must be a redis:// URL'),

    PUBLIC_WEB_URL: z.url(),
    PUBLIC_API_URL: z.url(),
    COOKIE_DOMAIN: optionalString,
    CORS_ORIGINS: csv,
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    STEAM_API_KEY: optionalString,
    STEAM_OPENID_URL: z.url().default('https://steamcommunity.com/openid'),
    /** SteamID64s that receive the Owner role at login (bootstraps the first administrator). */
    OWNER_STEAM_IDS: csv.pipe(z.array(z.string().regex(/^7656119\d{10}$/, 'must be SteamID64 values'))),

    SESSION_SECRET: secret,
    SERVER_API_SECRET: secret,
    ENCRYPTION_KEY: encryptionKey,

    DISCORD_WEBHOOK: optionalUrl,
    SKIN_PRICE_PROVIDER: z.enum(['skinport', 'none']).default('skinport'),
    SKIN_CATALOG_URL: z
      .url()
      .default('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json'),
    STICKER_CATALOG_URL: z
      .url()
      .default('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json'),

    AGENT_CATALOG_URL: z
      .url()
      .default('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/agents.json'),

    UPLOAD_DIR: z.string().default('./uploads'),
  })
  .superRefine((env, ctx) => {
    const add = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (env.SESSION_SECRET === env.SERVER_API_SECRET) {
      add('SERVER_API_SECRET', 'must differ from SESSION_SECRET');
    }
    if (env.NODE_ENV === 'production') {
      if (!env.STEAM_API_KEY) add('STEAM_API_KEY', 'is required in production');
      if (!env.PUBLIC_WEB_URL.startsWith('https://')) add('PUBLIC_WEB_URL', 'must use https in production');
      if (!env.PUBLIC_API_URL.startsWith('https://')) add('PUBLIC_API_URL', 'must use https in production');
      if (env.CORS_ORIGINS.length === 0) add('CORS_ORIGINS', 'must list the web origin in production');
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Validates the environment; messages name the variable but never echo its value. */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Loads the first .env found (repo root during development). Existing variables are never overridden. */
export function loadDotenvFile(candidates: readonly string[] = ['.env', '../../.env']): string | null {
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
      return path;
    }
  }
  return null;
}
