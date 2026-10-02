import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  PUBLIC_WEB_URL: 'http://localhost:3000',
  PUBLIC_API_URL: 'http://localhost:4000',
  SESSION_SECRET: 'a'.repeat(40),
  SERVER_API_SECRET: 'b'.repeat(40),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

const load = (extra: Record<string, string> = {}) => loadEnv({ ...valid, ...extra } as NodeJS.ProcessEnv);

describe('loadEnv', () => {
  it('accepts a minimal valid development environment and applies defaults', () => {
    const env = load();
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.STEAM_OPENID_URL).toBe('https://steamcommunity.com/openid');
    expect(env.CORS_ORIGINS).toEqual([]);
    expect(env.APP_ROLE).toBe('all');
  });

  it('treats empty optional values as unset', () => {
    const env = load({ STEAM_API_KEY: '', COOKIE_DOMAIN: '', DISCORD_WEBHOOK: '' });
    expect(env.STEAM_API_KEY).toBeUndefined();
    expect(env.COOKIE_DOMAIN).toBeUndefined();
    expect(env.DISCORD_WEBHOOK).toBeUndefined();
  });

  it('parses comma separated origins', () => {
    expect(load({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com ,' }).CORS_ORIGINS).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('refuses to start with missing or weak secrets', () => {
    expect(() => load({ SESSION_SECRET: 'short' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ ...valid, SERVER_API_SECRET: undefined } as unknown as NodeJS.ProcessEnv)).toThrow(/SERVER_API_SECRET/);
    expect(() => load({ ENCRYPTION_KEY: 'not-32-bytes' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('requires distinct session and server secrets', () => {
    expect(() => load({ SERVER_API_SECRET: valid.SESSION_SECRET })).toThrow(/must differ/);
  });

  it('never echoes secret values in error messages', () => {
    try {
      load({ SESSION_SECRET: 'tiny-secret-value' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('tiny-secret-value');
      expect((error as Error).message).toContain('SESSION_SECRET');
    }
  });

  it('is strict in production', () => {
    const production = { NODE_ENV: 'production' };
    expect(() => load(production)).toThrow(/STEAM_API_KEY/);
    expect(() => load({ ...production, STEAM_API_KEY: 'k' })).toThrow(/https/);
    expect(() =>
      load({
        ...production,
        STEAM_API_KEY: 'k',
        PUBLIC_WEB_URL: 'https://example.com',
        PUBLIC_API_URL: 'https://api.example.com',
      }),
    ).toThrow(/CORS_ORIGINS/);
    expect(
      load({
        ...production,
        STEAM_API_KEY: 'k',
        PUBLIC_WEB_URL: 'https://example.com',
        PUBLIC_API_URL: 'https://api.example.com',
        CORS_ORIGINS: 'https://example.com',
      }).NODE_ENV,
    ).toBe('production');
  });

  it('rejects malformed URLs and ports', () => {
    expect(() => load({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(() => load({ REDIS_URL: 'http://x' })).toThrow(/REDIS_URL/);
    expect(() => load({ API_PORT: '70000' })).toThrow(/API_PORT/);
  });
});
