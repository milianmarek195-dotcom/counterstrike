import type { AddressInfo } from 'node:net';
import { deriveServerKey } from '@celtist/shared/signing';
import { GatewayClient } from '@celtist/mock-cs2-server/client';
import { MockCs2Server } from '@celtist/mock-cs2-server/simulator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/**
 * End to end over real HTTP: the mock CS2 server talks to the API with signed requests, exactly like the plugin.
 * A party opens a 1v1, the server prepares and plays it, the signed result finishes the match and moves Elo once.
 */
describe('mock CS2 server against the real gateway', () => {
  let t: TestApp;
  let baseUrl: string;
  let leader: TestUser;
  let friend: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ startAt: new Date() }); // signatures use the wall clock
    await t.app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    leader = await createUser(t, { displayName: 'Leader' });
    friend = await createUser(t, { displayName: 'Friend' });
    outsider = await createUser(t, { displayName: 'Outsider' });
  });

  it('plays a party match from lobby to FINISHED, denies unassigned players, stores the result unrated', async () => {
    const server = await t.prisma.server.create({ data: { name: 'MOCK-01', ip: '127.0.0.1', port: 27015, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now() } });
    const key = deriveServerKey(t.config.env.SERVER_API_SECRET, server.id, server.keyVersion).toString('hex');
    const mock = new MockCs2Server(new GatewayClient({ baseUrl, serverId: server.id, apiKeyHex: key }), { roundMs: 1, forceWinner: 'A' });
    await mock.heartbeat();

    await as(t, leader).post('/v1/parties').expect(201);
    await as(t, leader).post('/v1/parties/invite', { userId: friend.id }).expect(204);
    const invite = (await as(t, friend).get('/v1/parties/me')).body.invites[0];
    await as(t, friend).post(`/v1/parties/invites/${invite.id}/accept`).expect(204);
    const matchId = (await as(t, leader).post('/v1/parties/match', { teamAMax: 1, teamBMax: 1 }).expect(201)).body.matchId as string;
    const control = (action: string, body: object = {}) => as(t, leader).post(`/v1/matches/${matchId}/control/${action}`, body);

    await control('assign-team', { userId: leader.id, team: 'A' }).expect(204);
    await control('assign-team', { userId: friend.id, team: 'B' }).expect(204);
    const dust = await t.prisma.gameMap.findUniqueOrThrow({ where: { key: 'de_dust2' } });
    await control('force-map', { mapId: dust.id }).expect(204);
    await control('start').expect(204);

    await mock.pollOnce(); // MATCH_PREPARE / START commands
    expect(mock.state.status).toBe('IN_USE');

    expect(await mock.playerJoins(outsider.steamId)).toBe(false);
    expect(mock.denied[0]!.reason).toBe('NOT_IN_MATCH');
    expect(await mock.playerJoins(leader.steamId)).toBe(true);
    expect(await mock.playerJoins(friend.steamId)).toBe(true);

    for (let i = 0; i < 100; i++) {
      const m = await t.prisma.match.findUniqueOrThrow({ where: { id: matchId } });
      if (m.status === 'FINISHED') break;
      if (m.status === 'CONFIGURING') await mock.pollOnce();
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await t.prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { maps: true } });
    expect(done.status).toBe('FINISHED');
    expect(done.winnerSlot).toBe('A');
    expect(done.maps[0]!.scoreA).toBeGreaterThan(done.maps[0]!.scoreB);

    // party/custom matches are unrated by design: the result is stored, Elo stays untouched
    expect(await t.prisma.eloChange.count({ where: { matchId } })).toBe(0);
    expect((await t.prisma.playerRank.findFirstOrThrow({ where: { userId: leader.id, mode: 'FIVE_V_FIVE' } })).elo).toBe(1000);
    const stats = await t.prisma.matchPlayer.findFirstOrThrow({ where: { matchId, userId: leader.id } });
    expect(stats.kills).toBeGreaterThan(0);
    // weapon-class kills arrive from the plugin and are stored per player (AWP / AK-47 / pistol)
    expect(stats).toMatchObject({ killsAwp: 2, killsAk47: 3, killsPistol: 1 });
    const profile = (await as(t, null).get(`/v1/players/${leader.steamId}`).expect(200)).body;
    expect(profile.modes.FIVE_V_FIVE.overall).toMatchObject({ killsAwp: 2, killsAk47: 3, killsPistol: 1 });
    const board = (await as(t, null).get(`/v1/matches/${matchId}/scoreboard`).expect(200)).body;
    expect(board.total.find((r: { steamId: string }) => r.steamId === leader.steamId)).toMatchObject({ killsAwp: 2, killsAk47: 3, killsPistol: 1 });
  }, 60_000);
});
