import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../common/clock.js';
import { AppConfig } from '../config/app-config.js';
import { loadEnv } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';
import { OpenIdError, SteamOpenIdService, sanitizeReturnTo, type OpenIdQuery } from './steam-openid.service.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const STEAM_ID = '76561198000000001';

function setup(fetchImpl?: typeof fetch) {
  const config = new AppConfig(
    loadEnv({
      DATABASE_URL: 'postgresql://x:y@localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      PUBLIC_WEB_URL: 'http://localhost:3000',
      PUBLIC_API_URL: 'http://localhost:4000',
      SESSION_SECRET: 'a'.repeat(40),
      SERVER_API_SECRET: 'b'.repeat(40),
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    } as NodeJS.ProcessEnv),
  );
  const redisClient = new RedisMock();
  const redis = new RedisService(redisClient as never);
  const clock = new FakeClock(NOW);
  const fetcher = vi.fn(
    fetchImpl ??
      (async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 })),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const service = new SteamOpenIdService(config, redis, clock, fetcher);
  return { service, redisClient, clock, fetcher };
}

let nonceCounter = 0;
function callback(state: string, overrides: Record<string, string | string[] | undefined> = {}): OpenIdQuery {
  const claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': claimed,
    'openid.identity': claimed,
    'openid.return_to': `http://localhost:4000/v1/auth/steam/callback?state=${state}`,
    'openid.response_nonce': `2026-10-02T12:00:00Znonce${++nonceCounter}`,
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'c2lnbmF0dXJl',
    state,
    ...overrides,
  } as OpenIdQuery;
}

async function started(service: SteamOpenIdService, returnTo?: string) {
  const { state, redirectUrl } = await service.startLogin(returnTo);
  return { state, redirectUrl };
}

describe('SteamOpenIdService.startLogin', () => {
  it('builds a checkid_setup request pinned to our callback and state', async () => {
    const { service } = setup();
    const { redirectUrl, state } = await started(service, '/profile');
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe('https://steamcommunity.com/openid/login');
    expect(url.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(url.searchParams.get('openid.ns')).toBe('http://specs.openid.net/auth/2.0');
    expect(url.searchParams.get('openid.return_to')).toBe(`http://localhost:4000/v1/auth/steam/callback?state=${state}`);
    expect(url.searchParams.get('openid.realm')).toBe('http://localhost:4000');
    expect(url.searchParams.get('openid.identity')).toBe('http://specs.openid.net/auth/2.0/identifier_select');
    expect(state.length).toBeGreaterThanOrEqual(30);
  });

  it('generates a different state each time', async () => {
    const { service } = setup();
    const a = await started(service);
    const b = await started(service);
    expect(a.state).not.toBe(b.state);
  });
});

describe('SteamOpenIdService.completeLogin', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('accepts a genuine response and returns the SteamID and the stored return path', async () => {
    const { state } = await started(ctx.service, '/tournaments/1');
    const result = await ctx.service.completeLogin(callback(state), state);
    expect(result).toEqual({ steamId: STEAM_ID, returnTo: '/tournaments/1' });
  });

  it('sends the response back to Steam for check_authentication', async () => {
    const { state } = await started(ctx.service);
    await ctx.service.completeLogin(callback(state), state);
    expect(ctx.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = ctx.fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://steamcommunity.com/openid/login');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('openid.mode')).toBe('check_authentication');
    expect(body.get('openid.sig')).toBe('c2lnbmF0dXJl');
    expect(body.get('openid.claimed_id')).toContain(STEAM_ID);
  });

  it('refuses when Steam does not confirm the signature', async () => {
    ctx = setup(async () => new Response('is_valid:false\n', { status: 200 }));
    const { state } = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(state), state)).rejects.toMatchObject({ reason: 'VERIFICATION_FAILED' });
  });

  it('treats a Steam outage as an error, never as success', async () => {
    ctx = setup(async () => new Response('oops', { status: 503 }));
    const { state } = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(state), state)).rejects.toMatchObject({ reason: 'STEAM_UNREACHABLE' });
    ctx = setup(async () => {
      throw new Error('network down');
    });
    const second = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(second.state), second.state)).rejects.toMatchObject({ reason: 'STEAM_UNREACHABLE' });
  });

  it('requires the browser state cookie to match (login CSRF)', async () => {
    const { state } = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(state), undefined)).rejects.toMatchObject({ reason: 'STATE_MISSING' });
    await expect(ctx.service.completeLogin(callback(state), 'another-browsers-state')).rejects.toMatchObject({ reason: 'STATE_MISMATCH' });
  });

  it('consumes the state: a response cannot be used twice', async () => {
    const { state } = await started(ctx.service);
    await ctx.service.completeLogin(callback(state), state);
    await expect(ctx.service.completeLogin(callback(state), state)).rejects.toMatchObject({ reason: 'STATE_MISSING' });
  });

  it('rejects states we never issued', async () => {
    await expect(ctx.service.completeLogin(callback('forged-state-value'), 'forged-state-value')).rejects.toMatchObject({
      reason: 'STATE_MISSING',
    });
  });

  it('rejects a replayed nonce even with a fresh state', async () => {
    const first = await started(ctx.service);
    const query = callback(first.state, { 'openid.response_nonce': '2026-10-02T12:00:00ZfixedNonce' });
    await ctx.service.completeLogin(query, first.state);

    const second = await started(ctx.service);
    const replay = callback(second.state, { 'openid.response_nonce': '2026-10-02T12:00:00ZfixedNonce' });
    await expect(ctx.service.completeLogin(replay, second.state)).rejects.toMatchObject({ reason: 'NONCE_REPLAYED' });
  });

  it('rejects stale and malformed nonces', async () => {
    const stale = await started(ctx.service);
    await expect(
      ctx.service.completeLogin(callback(stale.state, { 'openid.response_nonce': '2026-10-02T11:00:00Zold' }), stale.state),
    ).rejects.toMatchObject({ reason: 'NONCE_INVALID' });
    const future = await started(ctx.service);
    await expect(
      ctx.service.completeLogin(callback(future.state, { 'openid.response_nonce': '2026-10-02T13:00:00Zfuture' }), future.state),
    ).rejects.toMatchObject({ reason: 'NONCE_INVALID' });
    const bad = await started(ctx.service);
    await expect(
      ctx.service.completeLogin(callback(bad.state, { 'openid.response_nonce': 'not-a-nonce' }), bad.state),
    ).rejects.toMatchObject({ reason: 'NONCE_INVALID' });
  });

  const claimedWith = (suffix: string): Record<string, string> => ({
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${suffix}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${suffix}`,
  });
  const cases: Array<[string, (state: string) => Record<string, string | string[]>, string]> = [
    ['another provider', () => ({ 'openid.op_endpoint': 'https://evil.example/openid/login' }), 'WRONG_ENDPOINT'],
    ['wrong mode', () => ({ 'openid.mode': 'cancel' }), 'MALFORMED_RESPONSE'],
    ['wrong namespace', () => ({ 'openid.ns': 'http://specs.openid.net/auth/1.1' }), 'MALFORMED_RESPONSE'],
    ['non-Steam claimed id', () => ({
      'openid.claimed_id': `https://evil.example/openid/id/${STEAM_ID}`,
      'openid.identity': `https://evil.example/openid/id/${STEAM_ID}`,
    }), 'INVALID_CLAIMED_ID'],
    ['non-numeric claimed id', () => claimedWith('abc'), 'INVALID_CLAIMED_ID'],
    ['id with path suffix', () => claimedWith(`${STEAM_ID}/../x`), 'INVALID_CLAIMED_ID'],
    ['identity differs from claimed id', () => ({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000002' }), 'INVALID_CLAIMED_ID'],
    ['claimed id not signed', () => ({ 'openid.signed': 'signed,op_endpoint,identity,return_to,response_nonce' }), 'UNSIGNED_FIELDS'],
    ['return_to not signed', () => ({ 'openid.signed': 'signed,op_endpoint,claimed_id,identity,response_nonce' }), 'UNSIGNED_FIELDS'],
    ['return_to on another host', (s) => ({ 'openid.return_to': `http://evil.example:4000/v1/auth/steam/callback?state=${s}` }), 'RETURN_TO_MISMATCH'],
    ['return_to on another path', (s) => ({ 'openid.return_to': `http://localhost:4000/v1/other?state=${s}` }), 'RETURN_TO_MISMATCH'],
    ['duplicated parameter', () => ({ 'openid.claimed_id': ['a', 'b'] }), 'MALFORMED_RESPONSE'],
  ];
  it.each(cases)('rejects %s', async (_name, makeOverride, reason) => {
    const { state } = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(state, makeOverride(state)), state)).rejects.toMatchObject({ reason });
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });

  it('rejects a return_to carrying a different state', async () => {
    const { state } = await started(ctx.service);
    const query = callback(state, { 'openid.return_to': 'http://localhost:4000/v1/auth/steam/callback?state=someone-elses' });
    await expect(ctx.service.completeLogin(query, state)).rejects.toMatchObject({ reason: 'RETURN_TO_MISMATCH' });
  });

  it('never calls Steam for responses that already fail local checks', async () => {
    const { state } = await started(ctx.service);
    await ctx.service.completeLogin(callback(state, { 'openid.mode': 'cancel' }), state).catch(() => undefined);
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });

  it('exposes typed errors', async () => {
    const { state } = await started(ctx.service);
    await expect(ctx.service.completeLogin(callback(state), undefined)).rejects.toBeInstanceOf(OpenIdError);
  });
});

describe('sanitizeReturnTo', () => {
  it.each([
    ['/', '/'],
    ['/tournaments/42?tab=bracket', '/tournaments/42?tab=bracket'],
    ['/profile/76561198000000001', '/profile/76561198000000001'],
  ])('keeps the safe path %s', (input, expected) => expect(sanitizeReturnTo(input)).toBe(expected));

  it.each([
    ['//evil.example'],
    ['https://evil.example'],
    ['http://localhost:3000/x'],
    ['javascript:alert(1)'],
    ['/\\evil.example'],
    ['evil'],
    ['/path\nwith-newline'],
    ['/' + 'a'.repeat(250)],
    [''],
  ])('replaces %j with /', (input) => expect(sanitizeReturnTo(input)).toBe('/'));

  it('handles undefined', () => expect(sanitizeReturnTo(undefined)).toBe('/'));
});
