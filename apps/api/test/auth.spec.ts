import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTTP_FETCH } from '../src/steam/steam-openid.service.js';
import { SteamProfileSource, type SteamProfileData } from '../src/steam/steam-profile.source.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, SESSION_MAX_PER_USER, SessionService } from '../src/security/session.service.js';
import { as, createUser, nextSteamId } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const OWNER_STEAM_ID = '76561198999999999';

class FakeProfiles extends SteamProfileSource {
  override async fetchProfiles(ids: readonly string[]): Promise<Map<string, SteamProfileData>> {
    return new Map(
      ids.map((id) => [
        id,
        {
          steamId: id,
          personaName: `Persona ${id.slice(-4)}`,
          avatarSmall: 'https://avatars.steamstatic.com/s.jpg',
          avatarMedium: 'https://avatars.steamstatic.com/m.jpg',
          avatarFull: 'https://avatars.steamstatic.com/f.jpg',
          profileUrl: `https://steamcommunity.com/profiles/${id}`,
          countryCode: 'DE',
          visibilityState: 3,
          accountCreatedAt: new Date('2015-05-05T00:00:00Z'),
        },
      ]),
    );
  }
}

/** Plays Steam: answers check_authentication positively. */
const steamFetch = vi.fn(async () => new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 }));

describe('authentication', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      env: { OWNER_STEAM_IDS: OWNER_STEAM_ID },
      customise: (builder) =>
        builder.overrideProvider(HTTP_FETCH).useValue(steamFetch).overrideProvider(SteamProfileSource).useValue(new FakeProfiles()),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    steamFetch.mockClear();
  });

  /** Walks the real flow: /login → (Steam) → /callback, returning the callback response. */
  async function steamLogin(steamId: string, returnTo?: string) {
    const http = t.app.getHttpServer();
    const start = await request(http)
      .get('/v1/auth/steam/login')
      .query(returnTo ? { returnTo } : {})
      .expect(302);
    const steamUrl = new URL(start.headers.location!);
    const stateCookie = (start.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('celtist_oidstate='))!;
    const state = new URL(steamUrl.searchParams.get('openid.return_to')!).searchParams.get('state')!;

    const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
    const query = {
      'openid.ns': 'http://specs.openid.net/auth/2.0',
      'openid.mode': 'id_res',
      'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
      'openid.claimed_id': claimed,
      'openid.identity': claimed,
      'openid.return_to': steamUrl.searchParams.get('openid.return_to')!,
      'openid.response_nonce': `${t.clock.now().toISOString().slice(0, 19)}Z${Math.random().toString(36).slice(2)}`,
      'openid.assoc_handle': '1',
      'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
      'openid.sig': 'c2ln',
      state,
    };
    return { start, stateCookie, query, state, callback: () => request(http).get('/v1/auth/steam/callback').set('Cookie', stateCookie.split(';')[0]!).query(query) };
  }

  const cookiesOf = (res: request.Response): string[] => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  describe('login flow', () => {
    it('redirects to Steam and sets a short-lived HttpOnly state cookie', async () => {
      const { start, stateCookie } = await steamLogin(nextSteamId());
      expect(start.headers.location).toMatch(/^https:\/\/steamcommunity\.com\/openid\/login\?/);
      expect(stateCookie).toMatch(/HttpOnly/i);
      expect(stateCookie).toMatch(/SameSite=Lax/i);
      expect(stateCookie).toMatch(/Max-Age=600/);
      expect(stateCookie).toMatch(/Path=\/v1\/auth\/steam/);
    });

    it('creates the account, profile, rank rows and a secure session on first login', async () => {
      const steamId = nextSteamId();
      const flow = await steamLogin(steamId, '/tournaments');
      const res = await flow.callback().expect(302);

      expect(res.headers.location).toBe('http://localhost:3000/tournaments');
      const session = cookiesOf(res).find((c) => c.startsWith('celtist_session='))!;
      expect(session).toBeDefined();
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).toMatch(/Path=\//);
      expect(session).toMatch(/Max-Age=\d+/);
      // the state cookie is cleared again
      expect(cookiesOf(res).some((c) => c.startsWith('celtist_oidstate=;') || /celtist_oidstate=; /.test(c))).toBe(true);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { steamId }, include: { steamProfile: true, ranks: true, stats: true } });
      expect(user.displayName).toBe(`Persona ${steamId.slice(-4)}`);
      expect(user.avatarUrl).toBe('https://avatars.steamstatic.com/f.jpg');
      expect(user.steamProfile?.countryCode).toBe('DE');
      expect(user.ranks.map((r) => r.mode).sort()).toEqual(['FIVE_V_FIVE', 'WINGMAN']);
      expect(user.ranks.every((r) => r.elo === 1000 && r.peakElo === 1000)).toBe(true);
      expect(user.stats).toHaveLength(2);
      expect(user.lastLoginAt).not.toBeNull();
    });

    it('stores only a hash of the session token', async () => {
      const flow = await steamLogin(nextSteamId());
      const res = await flow.callback().expect(302);
      const token = cookiesOf(res).find((c) => c.startsWith('celtist_session='))!.split(';')[0]!.split('=')[1]!;
      const rows = await t.prisma.session.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toBe(token);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it('recognises returning players instead of duplicating them', async () => {
      const steamId = nextSteamId();
      await (await steamLogin(steamId)).callback().expect(302);
      await (await steamLogin(steamId)).callback().expect(302);
      expect(await t.prisma.user.count({ where: { steamId } })).toBe(1);
      expect(await t.prisma.session.count()).toBe(2);
      expect(await t.prisma.playerRank.count()).toBe(2);
    });

    it('grants the Owner role to bootstrap SteamIDs only', async () => {
      const owner = await steamLogin(OWNER_STEAM_ID);
      const ownerRes = await owner.callback().expect(302);
      const ownerCookie = cookiesOf(ownerRes).find((c) => c.startsWith('celtist_session='))!.split(';')[0]!;
      const me = await request(t.app.getHttpServer()).get('/v1/auth/me').set('Cookie', ownerCookie).expect(200);
      expect(me.body.roles).toEqual([{ key: 'owner', name: 'Owner' }]);
      expect(me.body.permissions).toContain('role.manage');

      const normal = await steamLogin(nextSteamId());
      const normalRes = await normal.callback().expect(302);
      const normalCookie = cookiesOf(normalRes).find((c) => c.startsWith('celtist_session='))!.split(';')[0]!;
      const normalMe = await request(t.app.getHttpServer()).get('/v1/auth/me').set('Cookie', normalCookie).expect(200);
      expect(normalMe.body.roles).toEqual([]);
      expect(normalMe.body.permissions).toEqual([]);
    });

    it('still signs the player in when Steam profile lookup is unavailable', async () => {
      const broken = new (class extends SteamProfileSource {
        override async fetchProfiles(): Promise<Map<string, SteamProfileData>> {
          throw new Error('Steam Web API down');
        }
      })();
      const t2 = await createTestApp({
        customise: (b) => b.overrideProvider(HTTP_FETCH).useValue(steamFetch).overrideProvider(SteamProfileSource).useValue(broken),
      });
      try {
        await t2.reset();
        const steamId = nextSteamId();
        const http = t2.app.getHttpServer();
        const start = await request(http).get('/v1/auth/steam/login').expect(302);
        const url = new URL(start.headers.location!);
        const state = new URL(url.searchParams.get('openid.return_to')!).searchParams.get('state')!;
        const claimed = `https://steamcommunity.com/openid/id/${steamId}`;
        const res = await request(http)
          .get('/v1/auth/steam/callback')
          .set('Cookie', `celtist_oidstate=${state}`)
          .query({
            'openid.ns': 'http://specs.openid.net/auth/2.0',
            'openid.mode': 'id_res',
            'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
            'openid.claimed_id': claimed,
            'openid.identity': claimed,
            'openid.return_to': url.searchParams.get('openid.return_to')!,
            'openid.response_nonce': `${t2.clock.now().toISOString().slice(0, 19)}Zxyz`,
            'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce',
            'openid.sig': 'c2ln',
            state,
          })
          .expect(302);
        expect(res.headers.location).toBe('http://localhost:3000/');
        const user = await t2.prisma.user.findUniqueOrThrow({ where: { steamId } });
        expect(user.displayName).toBe(`Player ${steamId.slice(-4)}`);
      } finally {
        await t2.close();
      }
    });
  });

  describe('login failures', () => {
    it('sends failed verifications to the web app without creating anything', async () => {
      const flow = await steamLogin(nextSteamId());
      steamFetch.mockResolvedValueOnce(new Response('is_valid:false', { status: 200 }));
      const res = await flow.callback().expect(302);
      expect(res.headers.location).toBe('http://localhost:3000/login/failed?reason=VERIFICATION_FAILED');
      expect(cookiesOf(res).some((c) => c.startsWith('celtist_session='))).toBe(false);
      expect(await t.prisma.user.count()).toBe(0);
      expect(await t.prisma.session.count()).toBe(0);
    });

    it('refuses a callback from a browser that never started the login (login CSRF)', async () => {
      const flow = await steamLogin(nextSteamId());
      const res = await request(t.app.getHttpServer()).get('/v1/auth/steam/callback').query(flow.query).expect(302);
      expect(res.headers.location).toBe('http://localhost:3000/login/failed?reason=STATE_MISSING');
      expect(await t.prisma.user.count()).toBe(0);
    });

    it('cannot be replayed', async () => {
      const flow = await steamLogin(nextSteamId());
      await flow.callback().expect(302);
      const again = await flow.callback().expect(302);
      expect(again.headers.location).toContain('/login/failed');
      expect(await t.prisma.session.count()).toBe(1);
    });

    it('never redirects to a foreign site after login', async () => {
      for (const evil of ['//evil.example/phish', 'https://evil.example', '/\\evil.example']) {
        const flow = await steamLogin(nextSteamId(), evil);
        const res = await flow.callback().expect(302);
        expect(res.headers.location).toBe('http://localhost:3000/');
      }
    });
  });

  describe('session usage', () => {
    it('/me is 200 and anonymous without a session', async () => {
      const res = await request(t.app.getHttpServer()).get('/v1/auth/me').expect(200);
      expect(res.body).toEqual({ user: null, roles: [], permissions: [], csrfToken: null });
    });

    it('/me returns the signed-in user and a CSRF token', async () => {
      const user = await createUser(t, { displayName: 'Alice' });
      const res = await as(t, user).get('/v1/auth/me').expect(200);
      expect(res.body.user).toMatchObject({ steamId: user.steamId, displayName: 'Alice' });
      expect(res.body.csrfToken).toBe(user.csrf);
    });

    it('drops and clears forged or stale cookies', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/v1/auth/me')
        .set('Cookie', 'celtist_session=' + 'x'.repeat(43))
        .expect(200);
      expect(res.body.user).toBeNull();
      expect(cookiesOf(res).some((c) => /celtist_session=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
    });

    it('expires idle sessions', async () => {
      const user = await createUser(t);
      t.clock.advance(SESSION_IDLE_MS - 60_000);
      expect((await as(t, user).get('/v1/auth/me')).body.user).not.toBeNull();
      // the request above refreshed the idle window; wait out a full idle period without activity
      t.clock.advance(SESSION_IDLE_MS + 60_000);
      await t.redis.flushall();
      expect((await as(t, user).get('/v1/auth/me')).body.user).toBeNull();
    });

    it('expires absolutely, even for active users', async () => {
      const user = await createUser(t);
      for (let i = 0; i < 5; i++) {
        t.clock.advance(SESSION_IDLE_MS - 3_600_000);
        await t.redis.flushall();
        await as(t, user).get('/v1/auth/me');
      }
      t.clock.advance(SESSION_ABSOLUTE_MS);
      await t.redis.flushall();
      expect((await as(t, user).get('/v1/auth/me')).body.user).toBeNull();
    });

    it('limits the number of concurrent sessions per user', async () => {
      const user = await createUser(t);
      const sessions = t.app.get(SessionService);
      for (let i = 0; i < SESSION_MAX_PER_USER + 3; i++) await sessions.create(user.id);
      const active = await t.prisma.session.count({ where: { userId: user.id, revokedAt: null } });
      expect(active).toBe(SESSION_MAX_PER_USER);
    });

    it('lists and revokes own sessions only', async () => {
      const alice = await createUser(t);
      const bob = await createUser(t);
      const other = await t.app.get(SessionService).create(alice.id);

      const list = await as(t, alice).get('/v1/auth/sessions').expect(200);
      expect(list.body.sessions).toHaveLength(2);
      expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain(other.token);

      await as(t, bob).delete(`/v1/auth/sessions/${other.sessionId}`).expect(404);
      await as(t, alice).delete(`/v1/auth/sessions/${other.sessionId}`).expect(204);
      expect((await as(t, alice).get('/v1/auth/sessions').expect(200)).body.sessions).toHaveLength(1);
      await as(t, alice).delete('/v1/auth/sessions/not-a-uuid').expect(400);
    });

    it('revoking a session takes effect immediately, despite caching', async () => {
      const user = await createUser(t);
      expect((await as(t, user).get('/v1/auth/me')).body.user).not.toBeNull(); // warms the cache
      await t.app.get(SessionService).revoke(user.sessionId);
      expect((await as(t, user).get('/v1/auth/me')).body.user).toBeNull();
    });

    it('logs out other devices', async () => {
      const user = await createUser(t);
      const sessions = t.app.get(SessionService);
      await sessions.create(user.id);
      await sessions.create(user.id);
      const res = await as(t, user).post('/v1/auth/logout-others').expect(201);
      expect(res.body).toEqual({ revoked: 2 });
      expect((await as(t, user).get('/v1/auth/me')).body.user).not.toBeNull();
    });
  });

  describe('logout and CSRF', () => {
    it('requires a session to log out', async () => {
      const res = await request(t.app.getHttpServer()).post('/v1/auth/logout').expect(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    });

    it('refuses state changes without the CSRF token', async () => {
      const user = await createUser(t);
      const res = await request(t.app.getHttpServer()).post('/v1/auth/logout').set('Cookie', user.cookie).expect(403);
      expect(res.body.error).toBe('CSRF_INVALID');
      expect((await as(t, user).get('/v1/auth/me')).body.user).not.toBeNull();
    });

    it('refuses a token belonging to another session', async () => {
      const alice = await createUser(t);
      const bob = await createUser(t);
      const res = await request(t.app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Cookie', alice.cookie)
        .set('X-CSRF-Token', bob.csrf)
        .expect(403);
      expect(res.body.error).toBe('CSRF_INVALID');
    });

    it('refuses requests from foreign origins even with a valid token', async () => {
      const user = await createUser(t);
      const res = await request(t.app.getHttpServer())
        .post('/v1/auth/logout')
        .set('Cookie', user.cookie)
        .set('X-CSRF-Token', user.csrf)
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(res.body.error).toBe('CSRF_ORIGIN');
    });

    it('logs out with cookie, token and origin, and clears the cookie', async () => {
      const user = await createUser(t);
      const res = await as(t, user).post('/v1/auth/logout').expect(204);
      expect(cookiesOf(res).some((c) => /celtist_session=;/.test(c) && /Max-Age=0/.test(c))).toBe(true);
      const after = await as(t, user).get('/v1/auth/me').expect(200);
      expect(after.body.user).toBeNull();
      expect((await t.prisma.session.findUniqueOrThrow({ where: { id: user.sessionId } })).revokedAt).not.toBeNull();
    });

    it('does not require a CSRF token for anonymous requests or safe methods', async () => {
      await request(t.app.getHttpServer()).get('/v1/auth/me').expect(200);
    });
  });

  describe('rate limiting of the login endpoints', () => {
    it('slows down repeated login attempts per client', async () => {
      const http = t.app.getHttpServer();
      let blocked = 0;
      for (let i = 0; i < 25; i++) {
        const res = await request(http).get('/v1/auth/steam/login');
        if (res.status === 429) blocked++;
      }
      expect(blocked).toBeGreaterThan(0);
    });
  });
});
