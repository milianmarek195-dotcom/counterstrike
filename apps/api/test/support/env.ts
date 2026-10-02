import { loadEnv, type AppEnv } from '../../src/config/env.js';

export function testEnv(databaseUrl: string, overrides: Record<string, string> = {}): AppEnv {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://localhost:6379',
    PUBLIC_WEB_URL: 'http://localhost:3000',
    PUBLIC_API_URL: 'http://localhost:4000',
    CORS_ORIGINS: 'http://localhost:3000',
    STEAM_API_KEY: 'test-steam-key',
    SESSION_SECRET: 's'.repeat(48),
    SERVER_API_SECRET: 'm'.repeat(48),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    SKIN_PRICE_PROVIDER: 'none',
    UPLOAD_DIR: './.local/test-uploads',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
