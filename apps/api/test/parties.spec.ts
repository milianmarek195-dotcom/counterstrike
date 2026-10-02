import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('parties and the website-first match flow', () => {
  let t: TestApp;
  let leader: TestUser;
  let friends: TestUser[];
  let admin: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['owner'] });
    leader = await createUser(t, { displayName: 'Leader' });
    friends = [];
    for (let i = 0; i < 5; i++) friends.push(await createUser(t, { displayName: `Friend${i}` }));
  });

  async function partyWith(members: TestUser[]) {
    await as(t, leader).post('/v1/parties').expect(201);
    for (const m of members) {
      await as(t, leader).post('/v1/parties/invite', { userId: m.id }).expect(204);
      const invite = (await as(t, m).get('/v1/parties/me')).body.invites[0];
      await as(t, m).post(`/v1/parties/invites/${invite.id}/accept`).expect(204);
    }
  }

  describe('party management', () => {
    it('creates a party with the creator as leader', async () => {
      const res = await as(t, leader).post('/v1/parties').expect(201);
      expect(res.body.party).toMatchObject({ isLeader: true, status: 'OPEN' });
      expect(res.body.party.members).toHaveLength(1);
      await as(t, leader).post('/v1/parties').expect(409);
      await as(t, null).post('/v1/parties').expect(401);
    });

    it('invites by id or SteamID, notifies the invitee and lets them accept or decline', async () => {
      await as(t, leader).post('/v1/parties').expect(201);
      await as(t, leader).post('/v1/parties/invite', { steamId: friends[0]!.steamId }).expect(204);
      await as(t, leader).post('/v1/parties/invite', { steamId: friends[0]!.steamId }).expect(409); // already invited
      await as(t, leader).post('/v1/parties/invite', { userId: leader.id }).expect(400);
      await as(t, leader).post('/v1/parties/invite', { steamId: '76561198123456780' }).expect(404);
      await as(t, leader).post('/v1/parties/invite', {}).expect(400);

      const note = (await as(t, friends[0]!).get('/v1/notifications')).body;
      expect(note.unread).toBe(1);
      expect(note.notifications[0]).toMatchObject({ type: 'party.invite' });
      await as(t, friends[0]!).post('/v1/notifications/read-all').expect(204);
      expect((await as(t, friends[0]!).get('/v1/notifications')).body.unread).toBe(0);

      await as(t, leader).post('/v1/parties/invite', { userId: friends[1]!.id }).expect(204);
      const decline = (await as(t, friends[1]!).get('/v1/parties/me')).body.invites[0];
      await as(t, friends[1]!).post(`/v1/parties/invites/${decline.id}/decline`).expect(204);
      await as(t, friends[1]!).post(`/v1/parties/invites/${decline.id}/accept`).expect(404);

      const accept = (await as(t, friends[0]!).get('/v1/parties/me')).body.invites[0];
      await as(t, friends[0]!).post(`/v1/parties/invites/${accept.id}/accept`).expect(204);
      expect((await as(t, leader).get('/v1/parties/me')).body.party.members).toHaveLength(2);
    });

    it('does not let strangers accept someone else’s invitation, and expires invitations', async () => {
      await as(t, leader).post('/v1/parties').expect(201);
      await as(t, leader).post('/v1/parties/invite', { userId: friends[0]!.id }).expect(204);
      const invite = (await as(t, friends[0]!).get('/v1/parties/me')).body.invites[0];
      await as(t, friends[1]!).post(`/v1/parties/invites/${invite.id}/accept`).expect(404);
      t.clock.advance(16 * 60_000);
      expect((await as(t, friends[0]!).post(`/v1/parties/invites/${invite.id}/accept`).expect(409)).body.error).toBe('INVITE_EXPIRED');
    });

    it('only the leader invites, kicks, transfers and disbands', async () => {
      await partyWith([friends[0]!, friends[1]!]);
      await as(t, friends[0]!).post('/v1/parties/invite', { userId: friends[2]!.id }).expect(403);
      await as(t, friends[0]!).post('/v1/parties/kick', { userId: friends[1]!.id }).expect(403);
      await as(t, friends[0]!).delete('/v1/parties').expect(403);
      await as(t, friends[2]!).post('/v1/parties/kick', { userId: friends[1]!.id }).expect(404); // not in any party

      await as(t, leader).post('/v1/parties/kick', { userId: friends[1]!.id }).expect(204);
      expect((await as(t, friends[1]!).get('/v1/parties/me')).body.party).toBeNull();
      await as(t, leader).post('/v1/parties/kick', { userId: leader.id }).expect(400);
      await as(t, leader).post('/v1/parties/transfer-leadership', { userId: friends[0]!.id }).expect(204);
      expect((await as(t, friends[0]!).get('/v1/parties/me')).body.party.isLeader).toBe(true);
      await as(t, leader).delete('/v1/parties').expect(403);
      await as(t, friends[0]!).delete('/v1/parties').expect(204);
      expect((await as(t, leader).get('/v1/parties/me')).body.party).toBeNull();
    });

    it('hands leadership on when the leader leaves, and disbands when the last member leaves', async () => {
      await partyWith([friends[0]!]);
      await as(t, leader).post('/v1/parties/leave').expect(204);
      expect((await as(t, friends[0]!).get('/v1/parties/me')).body.party.isLeader).toBe(true);
      await as(t, friends[0]!).post('/v1/parties/leave').expect(204);
      expect(await t.prisma.party.count()).toBe(0);
      await as(t, friends[0]!).post('/v1/parties/leave').expect(404);
    });

    it('limits a player to one party', async () => {
      await partyWith([friends[0]!]);
      const other = friends[1]!;
      await as(t, other).post('/v1/parties').expect(201);
      await as(t, other).post('/v1/parties/invite', { userId: friends[0]!.id }).expect(409); // already in a party
    });
  });

  describe('opening and steering a match from the party', () => {
    it('creates a match with free team sizes; everybody waits unassigned in the lobby; leader controls it', async () => {
      await partyWith(friends.slice(0, 4));
      const res = await as(t, leader).post('/v1/parties/match', { teamAMax: 2, teamBMax: 3, teamAName: 'Duo', teamBName: 'Trio' }).expect(201);
      const matchId = res.body.matchId as string;

      const match = (await as(t, leader).get(`/v1/matches/${matchId}`)).body;
      expect(match).toMatchObject({ kind: 'CUSTOM', status: 'WAITING', mode: 'FIVE_V_FIVE' });
      expect(match.teams.A).toMatchObject({ name: 'Duo', maxPlayers: 2, players: [] });
      expect(match.teams.B).toMatchObject({ name: 'Trio', maxPlayers: 3 });
      expect(match.unassigned).toHaveLength(5);
      expect(match.controller.id).toBe(leader.id);
      expect(match.viewer).toMatchObject({ role: 'PARTY_LEADER', canControl: true });
      expect((await as(t, leader).get('/v1/parties/me')).body.party).toMatchObject({ status: 'IN_MATCH', activeMatch: { id: matchId } });

      await as(t, leader).post('/v1/parties/match', {}).expect(409); // one open match at a time
      await as(t, friends[0]!).post('/v1/parties/match', {}).expect(403); // only the leader opens it
    });

    it('runs the whole flow: teams → map → server → connect → end', async () => {
      await partyWith(friends.slice(0, 4)); // 5 players
      const server = await t.prisma.server.create({ data: { name: 'EU-01', ip: '203.0.113.9', port: 27015, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now() } });
      const matchId = (await as(t, leader).post('/v1/parties/match', { teamAMax: 2, teamBMax: 3 }).expect(201)).body.matchId as string;
      const control = (u: TestUser, action: string, body: object = {}) => as(t, u).post(`/v1/matches/${matchId}/control/${action}`, body);

      // a free server was reserved automatically; the lobby is open
      expect((await as(t, leader).get(`/v1/matches/${matchId}`)).body.status).toBe('LOBBY');
      // nobody is on a team yet: no connect button, the plugin would say ACCESS DENIED
      expect((await as(t, friends[0]!).get(`/v1/matches/${matchId}`)).body.server).toBeNull();

      // TEAM A: leader + friend0; TEAM B: friends 1-3
      await control(leader, 'assign-team', { userId: leader.id, team: 'A' }).expect(204);
      await control(leader, 'assign-team', { userId: friends[0]!.id, team: 'A' }).expect(204);
      await control(leader, 'assign-team', { userId: friends[1]!.id, team: 'B' }).expect(204);
      await control(leader, 'assign-team', { userId: friends[2]!.id, team: 'B' }).expect(204);
      await control(leader, 'assign-team', { userId: friends[3]!.id, team: 'B' }).expect(204);
      await control(leader, 'assign-team', { userId: friends[3]!.id, team: 'A' }).expect(409); // team A already has its 2

      // MAP CONTROL
      const inferno = await t.prisma.gameMap.findUniqueOrThrow({ where: { key: 'de_inferno' } });
      await control(leader, 'force-map', { mapId: inferno.id }).expect(204);
      expect((await as(t, leader).get(`/v1/matches/${matchId}`)).body).toMatchObject({ status: 'MAP_FORCED', maps: [{ map: { name: 'Inferno' } }] });

      // MIT SERVER VERBINDEN: only assigned players see the address
      const view = (await as(t, friends[1]!).get(`/v1/matches/${matchId}`)).body;
      expect(view.server).toMatchObject({ name: 'EU-01', address: '203.0.113.9:27015', connect: 'steam://connect/203.0.113.9:27015' });
      expect((await as(t, admin).get(`/v1/matches/${matchId}`)).body.server).not.toBeNull();

      // START MATCH
      await control(leader, 'start').expect(204);
      expect((await t.prisma.match.findUniqueOrThrow({ where: { id: matchId } })).status).toBe('CONFIGURING');
      expect(await t.prisma.adminAction.count({ where: { serverId: server.id, type: 'MATCH_START' } })).toBe(1);

      // END MATCH hands the party back
      await control(leader, 'end', { reason: 'done' }).expect(204);
      await new Promise((r) => setTimeout(r, 200)); // the party is released by a domain-event listener
      expect((await as(t, leader).get('/v1/parties/me')).body.party).toMatchObject({ status: 'OPEN', activeMatch: null });
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).currentMatchId).toBeNull();

      // every manual step is in the audit log with the leader's role
      const audit = await t.prisma.auditLog.findMany({ where: { targetId: matchId }, orderBy: { createdAt: 'asc' } });
      expect(audit.map((a) => a.action)).toEqual(['match.assign_team', 'match.assign_team', 'match.assign_team', 'match.assign_team', 'match.assign_team', 'match.force_map', 'match.start', 'match.end']);
      expect(audit.every((a) => (a.metadata as { role: string }).role === 'PARTY_LEADER' && a.actorId === leader.id)).toBe(true);
    });

    it('a member who joins the party later appears in the open match lobby; one who leaves is removed from it', async () => {
      await as(t, leader).post('/v1/parties').expect(201);
      const matchId = (await as(t, leader).post('/v1/parties/match', {}).expect(201)).body.matchId as string;
      await as(t, leader).post('/v1/parties/invite', { userId: friends[0]!.id }).expect(204);
      const invite = (await as(t, friends[0]!).get('/v1/parties/me')).body.invites[0];
      await as(t, friends[0]!).post(`/v1/parties/invites/${invite.id}/accept`).expect(204);
      expect((await as(t, leader).get(`/v1/matches/${matchId}`)).body.unassigned).toHaveLength(2);
      await as(t, friends[0]!).post('/v1/parties/leave').expect(204);
      expect((await as(t, leader).get(`/v1/matches/${matchId}`)).body.unassigned).toHaveLength(1);
    });

    it('leadership transfer hands the running match to the new leader', async () => {
      await partyWith([friends[0]!]);
      const matchId = (await as(t, leader).post('/v1/parties/match', {}).expect(201)).body.matchId as string;
      await as(t, leader).post('/v1/parties/transfer-leadership', { userId: friends[0]!.id }).expect(204);
      await as(t, leader).post(`/v1/matches/${matchId}/control/pause`).expect(403);
      await as(t, friends[0]!).post(`/v1/matches/${matchId}/control/end`, { reason: 'mine now' }).expect(204);
    });

    it('rejects nonsensical team sizes', async () => {
      await as(t, leader).post('/v1/parties').expect(201);
      await as(t, leader).post('/v1/parties/match', { teamAMax: 0 }).expect(400);
      await as(t, leader).post('/v1/parties/match', { teamBMax: 17 }).expect(400);
      await as(t, leader).post('/v1/parties/match', { teamAMax: 1, teamBMax: 1 }).expect(201); // 1v1 is fine
    });
  });
});
