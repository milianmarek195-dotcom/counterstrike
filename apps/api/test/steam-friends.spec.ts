import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_FETCH } from '../src/steam/steam-openid.service.js';
import { as, createUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('party invites: Steam friends', () => {
  let t: TestApp;
  let mode: 'ok' | 'private' = 'ok';
  let friendIds: string[] = [];
  let calls = 0;

  beforeAll(async () => {
    t = await createTestApp({
      env: { STEAM_API_KEY: 'test-key' },
      customise: (b) =>
        b.overrideProvider(HTTP_FETCH).useValue(async () => {
          calls++;
          if (mode === 'private') return new Response('', { status: 401 });
          return new Response(JSON.stringify({ friendslist: { friends: friendIds.map((steamid) => ({ steamid, relationship: 'friend' })) } }));
        }),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    mode = 'ok';
    calls = 0;
  });

  it('lists only Steam friends that are registered, and caches the answer', async () => {
    const me = await createUser(t, { displayName: 'Me' });
    const friend = await createUser(t, { displayName: 'Buddy' });
    await createUser(t, { displayName: 'Stranger' });
    friendIds = [friend.steamId, '76561190000000099'];
    const res = (await as(t, me).get('/v1/parties/friends').expect(200)).body;
    expect(res.available).toBe(true);
    expect(res.friends.map((f: { displayName: string }) => f.displayName)).toEqual(['Buddy']);
    await as(t, me).get('/v1/parties/friends').expect(200);
    expect(calls).toBe(1);
    // the friend can then be invited by steamId
    await as(t, me).post('/v1/parties').expect(201);
    await as(t, me).post('/v1/parties/invite', { steamId: friend.steamId }).expect(204);
  });

  it('reports a private friend list', async () => {
    const me = await createUser(t);
    mode = 'private';
    const res = (await as(t, me).get('/v1/parties/friends').expect(200)).body;
    expect(res).toMatchObject({ available: false, reason: 'PRIVATE', friends: [] });
  });

  it('requires a login', async () => {
    await as(t, null).get('/v1/parties/friends').expect(401);
  });
});
