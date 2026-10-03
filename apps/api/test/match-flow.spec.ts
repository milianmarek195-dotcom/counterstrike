import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_HEADERS, deriveServerKey, signRequest } from '@celtist/shared/signing';
import request from 'supertest';
import type { MatchKind } from '@celtist/database';
import { MatchCoreModule } from '../src/matches/core/match-core.module.js';
import { MatchFactory } from '../src/matches/core/match-factory.service.js';
import { MatchLifecycleService } from '../src/matches/match-lifecycle.service.js';
import { MatchTicker } from '../src/matches/match-ticker.service.js';
import { MatchesModule } from '../src/matches/matches.module.js';
import { ServerHeartbeatService } from '../src/servers/server-heartbeat.service.js';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const MASTER = 'm'.repeat(48);

describe('match control (no ready check, flexible teams, party leader = admin)', () => {
  let t: TestApp;
  let leader: TestUser; // party leader, also player 0 of team A
  let players: TestUser[]; // 2 on team A (incl. leader), 3 on team B, 1 unassigned
  let outsider: TestUser;
  let admin: TestUser;
  let serverId: string;
  let matchId: string;

  beforeAll(async () => {
    t = await createTestApp({ imports: [MatchesModule, MatchCoreModule] });
  });
  afterAll(async () => {
    await t.close();
  });

  async function makeMatch(kind: MatchKind = 'CUSTOM', bestOf: 1 | 3 = 1) {
    const pool = await t.prisma.mapPool.findFirstOrThrow({ where: { mode: 'FIVE_V_FIVE' } });
    const created = await t.prisma.$transaction((tx) =>
      t.app.get(MatchFactory).create(tx, {
        kind,
        mode: 'FIVE_V_FIVE',
        bestOf,
        mapPoolId: pool.id,
        status: 'SCHEDULED',
        controllerId: kind === 'CUSTOM' ? leader.id : null,
        teams: [
          { slot: 'A', name: 'Alpha', maxPlayers: 2, players: [{ userId: players[0]!.id, isCaptain: true }, { userId: players[1]!.id }] },
          { slot: 'B', name: 'Bravo', maxPlayers: 3, players: [{ userId: players[2]!.id, isCaptain: true }, { userId: players[3]!.id }, { userId: players[4]!.id }] },
        ],
        unassignedUserIds: [players[5]!.id],
      }),
    );
    return created.id;
  }

  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['owner'] });
    outsider = await createUser(t);
    players = [];
    for (let i = 0; i < 6; i++) players.push(await createUser(t));
    leader = players[0]!;
    const server = await t.prisma.server.create({ data: { name: 's1', ip: '10.0.0.1', port: 27015, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now() } });
    serverId = server.id;
    matchId = await makeMatch();
  });

  const lifecycle = () => t.app.get(MatchLifecycleService);
  const status = async () => (await t.prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status;
  const heartbeat = () => t.app.get(ServerHeartbeatService).handle(serverId, { status: 'READY', currentMatchId: null, players: 4, version: '1', timestampMs: t.clock.nowMs() });
  const control = (user: TestUser | null, action: string, body: object = {}) => as(t, user).post(`/v1/matches/${matchId}/control/${action}`, body);
  const mapId = async (key: string) => (await t.prisma.gameMap.findUniqueOrThrow({ where: { key } })).id;

  const sign = (method: string, path: string, body = '') => {
    const nonce = `n${Math.random().toString(36).slice(2)}${Date.now()}`;
    const timestampMs = t.clock.nowMs();
    return {
      [SIGNATURE_HEADERS.server]: serverId,
      [SIGNATURE_HEADERS.timestamp]: String(timestampMs),
      [SIGNATURE_HEADERS.nonce]: nonce,
      [SIGNATURE_HEADERS.signature]: signRequest(deriveServerKey(MASTER, serverId, 1), { method, pathWithQuery: path, timestampMs, nonce, body }),
    };
  };
  const gwPost = (path: string, payload: object) => {
    const body = JSON.stringify(payload);
    return request(t.app.getHttpServer()).post(path).set(sign('POST', path, body)).set('content-type', 'application/json').send(body);
  };
  const gwGet = (path: string) => request(t.app.getHttpServer()).get(path).set(sign('GET', path));

  /** Result for the current map: team A (2 players) vs team B (3 players). */
  function resultFor(map: number, winner: 'A' | 'B', key = `result-key-${map}-${winner}`) {
    const stats = (steam: string, team: 'A' | 'B', kills: number) => ({ steamId: steam, team, rounds: 22, kills, deaths: 11, assists: 2, headshots: 3, damage: kills * 90, mvps: 2 });
    return {
      matchId, mapNumber: map, idempotencyKey: key,
      scoreA: winner === 'A' ? 13 : 9, scoreB: winner === 'B' ? 13 : 9, rounds: 22,
      startedAt: new Date(t.clock.nowMs() - 25 * 60_000).toISOString(),
      endedAt: new Date(t.clock.nowMs() - 1000).toISOString(),
      players: [stats(players[0]!.steamId, 'A', 18), stats(players[1]!.steamId, 'A', 14), stats(players[2]!.steamId, 'B', 12), stats(players[3]!.steamId, 'B', 9), stats(players[4]!.steamId, 'B', 7)],
    };
  }

  describe('lobby without a ready check', () => {
    it('allocates a server and opens the lobby; the server config knows each side’s own size', async () => {
      await lifecycle().markWaiting(matchId);
      expect(await status()).toBe('LOBBY');
      const prepare = await t.prisma.adminAction.findFirstOrThrow({ where: { serverId, type: 'MATCH_PREPARE' } });
      const config = (prepare.payload as { config: { teams: { A: { maxPlayers: number; players: unknown[] }; B: { maxPlayers: number; players: unknown[] } } } }).config;
      expect([config.teams.A.maxPlayers, config.teams.A.players.length]).toEqual([2, 2]);
      expect([config.teams.B.maxPlayers, config.teams.B.players.length]).toEqual([3, 3]); // the unassigned player is not on any team
    });

    it('has no ready endpoint any more', async () => {
      await lifecycle().markWaiting(matchId);
      await as(t, players[0]!).post(`/v1/matches/${matchId}/ready`, { ready: true }).expect(404);
    });

    it('stays WAITING without a free server and takes the match later', async () => {
      await t.prisma.server.update({ where: { id: serverId }, data: { status: 'STARTING' } });
      await lifecycle().markWaiting(matchId);
      expect(await status()).toBe('WAITING');
      await heartbeat();
      expect((await t.app.get(MatchTicker).runOnce()).allocated).toBe(1);
      expect(await status()).toBe('LOBBY');
    });
  });

  describe('who may control a match', () => {
    beforeEach(async () => {
      await lifecycle().markWaiting(matchId);
    });

    it('party leader and admin can; everybody else cannot – on every control action', async () => {
      const actions: Array<[string, object]> = [
        ['start-veto', {}], ['skip-veto', {}], ['start', {}], ['pause', {}], ['unpause', {}], ['resume', {}], ['restart', {}], ['end', {}],
        ['force-map', { mapId: await mapId('de_mirage') }], ['assign-team', { userId: players[5]!.id, team: 'A' }],
        ['add-player', { userId: outsider.id }], ['remove-player', { userId: players[1]!.id }], ['config', { bestOf: 3 }],
        ['assign-server', { serverId }], ['change-map', { mapNumber: 1, mapId: await mapId('de_mirage') }],
      ];
      for (const [action, body] of actions) {
        expect((await control(outsider, action, body)).status, `outsider ${action}`).toBe(403);
        expect((await control(players[3]!, action, body)).status, `team member ${action}`).toBe(403); // plain player, not the leader
        expect((await control(null, action, body)).status, `anonymous ${action}`).toBe(401);
      }
    });

    it('gives the party leader exactly the same rights as an admin', async () => {
      const mirage = await mapId('de_mirage');
      for (const who of [leader, admin]) {
        await control(who, 'force-map', { mapId: mirage }).expect(204);
        await control(who, 'start-veto').expect(204);
        await control(who, 'config', { teamAName: `Named by ${who === admin ? 'admin' : 'leader'}` }).expect(204);
      }
      expect(await status()).toBe('VETO');
    });

    it('does not let a leader steer someone else’s match', async () => {
      const other = await createUser(t);
      await t.prisma.match.update({ where: { id: matchId }, data: { controllerId: other.id } });
      await control(leader, 'force-map', { mapId: await mapId('de_mirage') }).expect(403);
      await control(other, 'force-map', { mapId: await mapId('de_mirage') }).expect(204);
    });

    it('shows each viewer their role', async () => {
      expect((await as(t, leader).get(`/v1/matches/${matchId}`)).body.viewer).toMatchObject({ canControl: true, role: 'PARTY_LEADER' });
      expect((await as(t, admin).get(`/v1/matches/${matchId}`)).body.viewer).toMatchObject({ canControl: true, role: 'ADMIN' });
      expect((await as(t, players[3]!).get(`/v1/matches/${matchId}`)).body.viewer).toMatchObject({ canControl: false, role: null, isParticipant: true });
    });
  });

  describe('teams are independent and any size', () => {
    beforeEach(async () => {
      await lifecycle().markWaiting(matchId);
    });

    it('moves players between TEAM A, TEAM B and UNASSIGNED within each side’s limit', async () => {
      // team A allows 2 and has 2
      const full = await control(leader, 'assign-team', { userId: players[5]!.id, team: 'A' }).expect(409);
      expect(full.body.error).toBe('TEAM_FULL');
      // unassign someone from B, then B (max 3) has room again
      await control(leader, 'assign-team', { userId: players[4]!.id, team: null }).expect(204);
      await control(leader, 'assign-team', { userId: players[5]!.id, team: 'B' }).expect(204);

      const view = (await as(t, leader).get(`/v1/matches/${matchId}`)).body;
      expect(view.teams.A.players.map((p: { userId: string }) => p.userId).sort()).toEqual([players[0]!.id, players[1]!.id].sort());
      expect(view.teams.B.players.map((p: { userId: string }) => p.userId)).toContain(players[5]!.id);
      expect(view.unassigned.map((p: { userId: string }) => p.userId)).toEqual([players[4]!.id]);
      expect(view.teams.A.maxPlayers).toBe(2);
      expect(view.teams.B.maxPlayers).toBe(3);
    });

    it('keeps a captain on every team and refreshes the team average', async () => {
      await control(leader, 'assign-team', { userId: players[2]!.id, team: null }).expect(204); // B's captain leaves
      const b = await t.prisma.matchTeam.findFirstOrThrow({ where: { matchId, slot: 'B' }, include: { players: true } });
      expect(b.players.filter((p) => p.isCaptain)).toHaveLength(1);
      expect(b.players.find((p) => p.isCaptain)!.userId).not.toBe(players[2]!.id);
    });

    it('can change team sizes while setting up, but not below the current roster', async () => {
      await control(leader, 'config', { teamAMax: 4, teamBMax: 4 }).expect(204);
      await control(leader, 'assign-team', { userId: players[5]!.id, team: 'A' }).expect(204);
      const refused = await control(leader, 'config', { teamBMax: 2 }).expect(409);
      expect(refused.body.error).toBe('TEAM_TOO_SMALL');
      await control(leader, 'config', { teamAMax: 20 }).expect(400);
    });

    it('adds and removes players, and takes new players only from the platform', async () => {
      const newcomer = await createUser(t);
      await control(leader, 'add-player', { userId: newcomer.id }).expect(204); // into the lobby, unassigned
      await control(leader, 'add-player', { userId: newcomer.id }).expect(409);
      await control(leader, 'add-player', { steamId: '76561198123456789' }).expect(404);
      await t.prisma.ban.create({ data: { userId: outsider.id, type: 'PLATFORM', reason: 'x' } });
      await control(leader, 'add-player', { userId: outsider.id }).expect(403);
      await control(leader, 'remove-player', { userId: newcomer.id }).expect(204);
      const row = await t.prisma.matchPlayer.findFirstOrThrow({ where: { matchId, userId: newcomer.id } });
      expect(row.removedAt).not.toBeNull();
    });

    it('lets only admins touch tournament line-ups', async () => {
      const tournamentMatch = await makeMatch('TOURNAMENT');
      await t.prisma.match.update({ where: { id: tournamentMatch }, data: { controllerId: leader.id } }); // even if someone were the controller
      const res = await as(t, leader).post(`/v1/matches/${tournamentMatch}/control/remove-player`, { userId: players[3]!.id }).expect(403);
      expect(res.body.error).toBe('TOURNAMENT_LINEUP_LOCKED');
    });
  });

  describe('map control: force, veto, start', () => {
    beforeEach(async () => {
      await lifecycle().markWaiting(matchId);
    });

    it('forces a map: state MAP_FORCED, audit with old and new map, the map reaches the server config', async () => {
      await control(leader, 'force-map', { mapId: await mapId('de_mirage'), reason: 'we want Mirage' }).expect(204);
      expect(await status()).toBe('MAP_FORCED');
      await control(leader, 'force-map', { mapId: await mapId('de_inferno') }).expect(204);
      const audits = await t.prisma.auditLog.findMany({ where: { action: 'match.force_map', targetId: matchId }, orderBy: { createdAt: 'asc' } });
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({ actorId: leader.id, reason: 'we want Mirage', oldValue: { map: null, mapNumber: 1 }, newValue: { map: 'Mirage', state: 'MAP_FORCED' } });
      expect(audits[0]!.metadata).toMatchObject({ role: 'PARTY_LEADER' });
      expect(audits[1]).toMatchObject({ oldValue: { map: 'Mirage' }, newValue: { map: 'Inferno' } });
      await control(admin, 'force-map', { mapId: await mapId('de_nuke') }).expect(204);
      expect((await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'match.force_map', actorId: admin.id } })).metadata).toMatchObject({ role: 'ADMIN' });
    });

    it('overrides a running veto and discards its decisions', async () => {
      await control(leader, 'start-veto').expect(204);
      expect(await status()).toBe('VETO');
      const veto = (await as(t, null).get(`/v1/matches/${matchId}/veto`)).body;
      await control(leader, 'force-map', { mapId: veto.remaining[0].id }).expect(204);
      expect(await status()).toBe('MAP_FORCED');
      expect(await t.prisma.matchVetoAction.count({ where: { matchId } })).toBe(0);
      expect((await t.prisma.match.findUniqueOrThrow({ where: { id: matchId } })).vetoDeadline).toBeNull();
    });

    it('validates the forced map on the server: pool, availability, slot, state', async () => {
      const custom = await t.prisma.gameMap.create({ data: { key: 'de_outside', name: 'Outside', modes: ['FIVE_V_FIVE'] } });
      const notInPool = await control(leader, 'force-map', { mapId: custom.id }).expect(409);
      expect(notInPool.body.error).toBe('MAP_NOT_IN_POOL');
      await t.prisma.gameMap.update({ where: { key: 'de_anubis' }, data: { active: false } });
      expect((await control(leader, 'force-map', { mapId: await mapId('de_anubis') }).expect(409)).body.error).toBe('MAP_NOT_AVAILABLE');
      expect((await control(leader, 'force-map', { mapId: await mapId('de_mirage'), mapNumber: 2 }).expect(409)).body.error).toBe('INVALID_MAP_NUMBER');
      await control(leader, 'force-map', { mapId: 'not-a-uuid' }).expect(400);

      await control(leader, 'force-map', { mapId: await mapId('de_mirage') }).expect(204);
      await control(leader, 'start').expect(204);
      expect((await control(leader, 'force-map', { mapId: await mapId('de_inferno') }).expect(409)).body.error).toBe('MAP_LOCKED');
    });

    it('needs maps, teams and a server before it can start', async () => {
      expect((await control(leader, 'start').expect(409)).body.error).toBe('MAPS_INCOMPLETE');
      await control(leader, 'force-map', { mapId: await mapId('de_mirage') }).expect(204);
      await control(leader, 'assign-team', { userId: players[0]!.id, team: null }).expect(204);
      await control(leader, 'assign-team', { userId: players[1]!.id, team: null }).expect(204);
      expect((await control(leader, 'start').expect(409)).body.error).toBe('TEAMS_EMPTY');
      await control(leader, 'assign-team', { userId: players[0]!.id, team: 'A' }).expect(204);

      await control(leader, 'start').expect(204);
      expect(await status()).toBe('CONFIGURING');
      const start = await t.prisma.adminAction.findFirstOrThrow({ where: { serverId, type: 'MATCH_START' } });
      expect((start.payload as { config: { maps: Array<{ key: string }> } }).config.maps.map((m) => m.key)).toEqual(['de_mirage']);
      expect((await control(leader, 'start').expect(409)).body.error).toBe('INVALID_MATCH_STATE');
    });

    it('a best-of-3 needs every map slot decided', async () => {
      const bo3 = await makeMatch('CUSTOM', 3);
      const run = (action: string, body: object = {}) => as(t, leader).post(`/v1/matches/${bo3}/control/${action}`, body);
      await lifecycle().markWaiting(bo3).catch(() => undefined);
      await t.prisma.server.create({ data: { name: 's2', ip: '10.0.0.2', port: 27016, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now() } });
      await lifecycle().tryAllocate(bo3);
      await run('force-map', { mapId: await mapId('de_mirage'), mapNumber: 1 }).expect(204);
      expect((await run('start').expect(409)).body.error).toBe('MAPS_INCOMPLETE');
      await run('force-map', { mapId: await mapId('de_inferno'), mapNumber: 2 }).expect(204);
      await run('force-map', { mapId: await mapId('de_mirage'), mapNumber: 3 }).expect(409); // same map twice
      await run('force-map', { mapId: await mapId('de_nuke'), mapNumber: 3 }).expect(204);
      await run('start').expect(204);
    });

    it('lets the controller decide the veto for either team, or skip it', async () => {
      await control(leader, 'start-veto').expect(204);
      const v = (await as(t, null).get(`/v1/matches/${matchId}/veto`)).body;
      // a non-captain team member cannot act; an admin without a team may decide for the team on turn (a playing leader only for their own team)
      const memberOnTurn = v.current.team === 'A' ? players[1]! : players[3]!;
      await as(t, memberOnTurn).post(`/v1/matches/${matchId}/veto`, { action: 'BAN', mapId: v.remaining[0].id }).expect(403);
      await as(t, admin).post(`/v1/matches/${matchId}/veto`, { action: 'BAN', mapId: v.remaining[0].id }).expect(201);

      await control(leader, 'skip-veto').expect(204);
      expect(await status()).toBe('CONFIGURING');
      expect(await t.prisma.matchMap.count({ where: { matchId } })).toBe(1);
      expect(await t.prisma.adminAction.count({ where: { serverId, type: 'MATCH_START' } })).toBe(1);
      expect(await t.prisma.auditLog.count({ where: { action: 'match.veto_skip', targetId: matchId } })).toBe(1);
    });
  });

  describe('server access: only assigned players', () => {
    beforeEach(async () => {
      await lifecycle().markWaiting(matchId);
    });

    it('shows the connect address to assigned players and controllers only', async () => {
      const addr = (u: TestUser | null) => as(t, u).get(`/v1/matches/${matchId}`).then((r) => r.body.server?.address ?? null);
      expect(await addr(players[3]!)).toBe('10.0.0.1:27015');
      expect(await addr(leader)).toBe('10.0.0.1:27015');
      expect(await addr(admin)).toBe('10.0.0.1:27015');
      expect(await addr(players[5]!)).toBeNull(); // in the lobby but not on a team
      expect(await addr(outsider)).toBeNull();
      expect(await addr(null)).toBeNull();
    });

    it('the plugin check denies unassigned, removed and foreign players (ACCESS DENIED)', async () => {
      const check = async (u: TestUser) => (await gwPost('/server/v1/players/authorize', { steamId: u.steamId }).expect(200)).body;
      expect(await check(players[3]!)).toMatchObject({ allowed: true, team: 'B' });
      expect(await check(players[5]!)).toMatchObject({ allowed: false, reason: 'NOT_ASSIGNED' });
      expect(await check(outsider)).toMatchObject({ allowed: false, reason: 'NOT_IN_MATCH' });
      await control(leader, 'remove-player', { userId: players[3]!.id }).expect(204);
      expect(await check(players[3]!)).toMatchObject({ allowed: false, reason: 'REMOVED_FROM_MATCH' });
      await control(leader, 'assign-team', { userId: players[5]!.id, team: 'B' }).expect(204);
      expect(await check(players[5]!)).toMatchObject({ allowed: true, team: 'B' });
    });
  });

  describe('playing a 2v3 match through to the result', () => {
    async function goLive() {
      await lifecycle().markWaiting(matchId);
      await control(leader, 'force-map', { mapId: await mapId('de_mirage') }).expect(204);
      await control(leader, 'start').expect(204);
      await gwPost('/server/v1/events', { events: [{ seq: 1, idempotencyKey: `evt-live-${matchId.slice(0, 8)}`, at: t.clock.nowMs(), matchId, type: 'map.started', mapNumber: 1 }] }).expect(200);
      expect(await status()).toBe('LIVE');
    }

    it('accepts the result of unequal teams, stores stats, applies no Elo to custom matches and frees the server', async () => {
      await goLive();
      const res = await gwPost(`/server/v1/matches/${matchId}/result`, resultFor(1, 'A')).expect(200);
      expect(res.body).toEqual({ status: 'MATCH_FINISHED', duplicate: false, nextMapNumber: null });
      expect(await status()).toBe('FINISHED');
      expect(await t.prisma.eloChange.count()).toBe(0); // party matches are unrated
      const stats = await t.prisma.playerStats.findUniqueOrThrow({ where: { userId_mode: { userId: players[0]!.id, mode: 'FIVE_V_FIVE' } } });
      expect(stats).toMatchObject({ kills: 18, rounds: 22 });
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: serverId } })).currentMatchId).toBeNull();
      const board = (await as(t, null).get(`/v1/matches/${matchId}/scoreboard`)).body;
      expect(board.total).toHaveLength(5);
    });

    it('rates unequal teams by their average Elo when the match is a rated one', async () => {
      const rated = await makeMatch('MATCHMAKING');
      await t.prisma.match.update({ where: { id: rated }, data: { controllerId: leader.id } });
      await lifecycle().markWaiting(rated);
      const run = (action: string, body: object = {}) => as(t, leader).post(`/v1/matches/${rated}/control/${action}`, body);
      await run('force-map', { mapId: await mapId('de_mirage') }).expect(204);
      await run('start').expect(204);
      await gwPost('/server/v1/events', { events: [{ seq: 1, idempotencyKey: 'evt-rated-0001', at: t.clock.nowMs(), matchId: rated, type: 'map.started', mapNumber: 1 }] }).expect(200);
      await gwPost(`/server/v1/matches/${rated}/result`, { ...resultFor(1, 'A'), matchId: rated, idempotencyKey: 'result-rated-1' }).expect(200);
      expect(await t.prisma.eloChange.count({ where: { matchId: rated } })).toBe(5); // 2 + 3 players, each rated once
      const winner = await t.prisma.eloChange.findFirstOrThrow({ where: { matchId: rated, userId: players[0]!.id } });
      const loser = await t.prisma.eloChange.findFirstOrThrow({ where: { matchId: rated, userId: players[2]!.id } });
      expect(winner.delta).toBeGreaterThan(0);
      expect(loser.delta).toBeLessThan(0);
    });

    it('applies results exactly once, even when delivered several times at the same moment', async () => {
      const rated = await makeMatch('MATCHMAKING');
      await t.prisma.match.update({ where: { id: rated }, data: { controllerId: leader.id } });
      await lifecycle().markWaiting(rated);
      const run = (action: string, body: object = {}) => as(t, leader).post(`/v1/matches/${rated}/control/${action}`, body);
      await run('force-map', { mapId: await mapId('de_mirage') }).expect(204);
      await run('start').expect(204);
      const body = { ...resultFor(1, 'B'), matchId: rated, idempotencyKey: 'result-dup-0001' };
      const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => gwPost(`/server/v1/matches/${rated}/result`, body)));
      for (const r of [r1, r2, r3]) expect(r.status).toBe(200);
      expect([r1, r2, r3].filter((r) => r.body.duplicate === false)).toHaveLength(1);
      expect(await t.prisma.eloChange.count({ where: { matchId: rated } })).toBe(5);
    });

    it('rejects results naming players that are not in the match', async () => {
      await goLive();
      const bad = resultFor(1, 'A');
      bad.players[0]!.steamId = outsider.steamId;
      const res = await gwPost(`/server/v1/matches/${matchId}/result`, bad).expect(422);
      expect(res.body.details.join()).toMatch(/UNKNOWN_PLAYER/);
      expect(await status()).toBe('LIVE');
    });

    it('rejects a player who was never put on a team', async () => {
      await goLive();
      const bad = resultFor(1, 'A');
      bad.players[0]!.steamId = players[5]!.steamId; // unassigned lobby player
      expect((await gwPost(`/server/v1/matches/${matchId}/result`, bad).expect(422)).body.details.join()).toMatch(/UNKNOWN_PLAYER/);
    });

    it('pauses, unpauses and ends the match by command; the leader may do it, an outsider may not', async () => {
      await goLive();
      await control(outsider, 'pause').expect(403);
      await control(leader, 'pause', { reason: 'toilet' }).expect(204);
      await control(leader, 'unpause').expect(204);
      expect(await t.prisma.adminAction.count({ where: { serverId, type: 'MATCH_PAUSE' } })).toBe(1);
      expect(await t.prisma.adminAction.count({ where: { serverId, type: 'MATCH_UNPAUSE' } })).toBe(1);

      await control(leader, 'end', { reason: 'enough for today' }).expect(204);
      expect(await status()).toBe('CANCELLED');
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: serverId } })).currentMatchId).toBeNull();
      expect(await t.prisma.eloChange.count()).toBe(0);
      const audit = await t.prisma.auditLog.findMany({ where: { targetId: matchId }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['match.force_map', 'match.start', 'match.pause', 'match.resume', 'match.end']));
      expect(audit.every((a) => a.actorId === leader.id)).toBe(true);
      expect(audit.every((a) => (a.metadata as { role: string }).role === 'PARTY_LEADER')).toBe(true);
    });

    it('moves a running match to SERVER_ERROR when the server goes silent, and never rates it', async () => {
      const rated = await makeMatch('MATCHMAKING');
      await t.prisma.match.update({ where: { id: rated }, data: { controllerId: leader.id } });
      await lifecycle().markWaiting(rated);
      await as(t, leader).post(`/v1/matches/${rated}/control/force-map`, { mapId: await mapId('de_mirage') }).expect(204);
      await as(t, leader).post(`/v1/matches/${rated}/control/start`).expect(204);
      t.clock.advance(31_000);
      await t.app.get(MatchTicker).runOnce();
      await new Promise((r) => setTimeout(r, 200));
      expect((await t.prisma.match.findUniqueOrThrow({ where: { id: rated } })).status).toBe('SERVER_ERROR');
      expect(await t.prisma.eloChange.count()).toBe(0);
    });

    it('serves the full server config to the plugin, only for its own match', async () => {
      await lifecycle().markWaiting(matchId);
      const config = (await gwGet(`/server/v1/matches/${matchId}/config`).expect(200)).body;
      expect(config.teams.A.players).toHaveLength(2);
      expect(config.teams.B.players).toHaveLength(3);
      expect(config.adminSteamIds).toContain(admin.steamId);
    });
  });
});
