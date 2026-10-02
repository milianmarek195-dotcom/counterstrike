import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { MatchDriver } from './support/match-driver.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('tournaments', () => {
  let t: TestApp;
  let admin: TestUser;
  let users: TestUser[];
  let driver: MatchDriver;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['tournament_admin'] });
    users = [];
    for (let i = 0; i < 8; i++) users.push(await createUser(t));
    driver = new MatchDriver(t, new Map(users.map((u) => [u.id, u])));
  });

  const body = (over: Record<string, unknown> = {}) => ({
    name: 'Friday Cup',
    format: 'SINGLE_ELIMINATION',
    mode: 'FIVE_V_FIVE',
    teamSize: 2,
    maxTeams: 4,
    minTeams: 2,
    bestOf: 1,
    startsAt: '2026-10-03T18:00:00Z',
    registrationOpen: true,
    ...over,
  });

  async function create(over: Record<string, unknown> = {}, publish = true) {
    const res = await as(t, admin).post('/v1/admin/tournaments', body(over)).expect(201);
    if (publish) await as(t, admin).post(`/v1/admin/tournaments/${res.body.id}/publish`).expect(204);
    return res.body.id as string;
  }

  describe('creating and editing', () => {
    it('creates a draft with defaults from the platform and records an audit entry', async () => {
      const res = await as(t, admin).post('/v1/admin/tournaments', body()).expect(201);
      expect(res.body).toMatchObject({ status: 'DRAFT', teamSize: 2, mode: 'FIVE_V_FIVE', bestOf: 1 });
      const pool = await t.prisma.mapPool.findUniqueOrThrow({ where: { id: res.body.mapPoolId } });
      expect(pool.mode).toBe('FIVE_V_FIVE');
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'tournament.create' } });
      expect(audit.actorId).toBe(admin.id);
    });

    it('uses 5 players per team by default, takes any size, rejects Wingman (coming soon), unsupported formats and bad input', async () => {
      expect((await as(t, admin).post('/v1/admin/tournaments', body({ teamSize: undefined }))).body.teamSize).toBe(5);
      expect((await as(t, admin).post('/v1/admin/tournaments', body({ teamSize: 3 }))).body.teamSize).toBe(3);
      const wingman = await as(t, admin).post('/v1/admin/tournaments', body({ mode: 'WINGMAN' })).expect(400);
      expect(JSON.stringify(wingman.body.details)).toContain('coming soon');
      await as(t, admin).post('/v1/admin/tournaments', body({ teamSize: 17 })).expect(400);
      await as(t, admin).post('/v1/admin/tournaments', body({ format: 'SWISS' })).expect(400);
      await as(t, admin).post('/v1/admin/tournaments', body({ name: 'x' })).expect(400);
      await as(t, admin).post('/v1/admin/tournaments', body({ minTeams: 8, maxTeams: 4 })).expect(400);
      await as(t, admin).post('/v1/admin/tournaments', body({ format: 'DOUBLE_ELIMINATION', minTeams: 2 })).expect(400);
      await as(t, admin).post('/v1/admin/tournaments', body({ startsAt: 'tomorrow' })).expect(400);
    });

    it('is only possible with the right permissions', async () => {
      await as(t, null).post('/v1/admin/tournaments', body()).expect(401);
      await as(t, users[0]!).post('/v1/admin/tournaments', body()).expect(403);
      const moderator = await createUser(t, { roles: ['moderator'] });
      await as(t, moderator).post('/v1/admin/tournaments', body()).expect(403);
    });

    it('hides drafts from the public until published', async () => {
      const id = await create({}, false);
      expect((await as(t, null).get('/v1/tournaments')).body.total).toBe(0);
      await as(t, null).get(`/v1/tournaments/${id}`).expect(404);
      await as(t, admin).get(`/v1/tournaments/${id}`).expect(200);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/publish`).expect(204);
      expect((await as(t, null).get('/v1/tournaments')).body.total).toBe(1);
      expect((await as(t, null).get(`/v1/tournaments/${id}`).expect(200)).body.mapPool.maps.length).toBeGreaterThan(0);
    });

    it('edits while open and records old and new values; locks structure after start', async () => {
      const id = await create();
      await as(t, admin).patch(`/v1/admin/tournaments/${id}`, { name: 'Renamed Cup', bestOf: 3 }).expect(200);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'tournament.edit' } });
      expect(audit.oldValue).toMatchObject({ name: 'Friday Cup', bestOf: 1 });
      expect(audit.newValue).toMatchObject({ name: 'Renamed Cup', bestOf: 3 });
      await t.prisma.tournament.update({ where: { id }, data: { status: 'RUNNING' } });
      await as(t, admin).patch(`/v1/admin/tournaments/${id}`, { bestOf: 1 }).expect(409);
      await as(t, admin).patch(`/v1/admin/tournaments/${id}`, { description: 'still editable' }).expect(200);
    });

    it('deletes only unstarted tournaments', async () => {
      const id = await create();
      await as(t, admin).delete(`/v1/admin/tournaments/${id}`).expect(204);
      const running = await create({ name: 'Running Cup' });
      await t.prisma.tournament.update({ where: { id: running }, data: { status: 'RUNNING' } });
      await as(t, admin).delete(`/v1/admin/tournaments/${running}`).expect(409);
    });
  });

  describe('registration', () => {
    it('lets players sign up once, and withdraw', async () => {
      const id = await create();
      await as(t, users[0]!).post(`/v1/tournaments/${id}/register`, {}).expect(201);
      expect((await as(t, users[0]!).post(`/v1/tournaments/${id}/register`, {}).expect(409)).body.error).toBe('ALREADY_REGISTERED');
      expect((await as(t, users[0]!).get(`/v1/tournaments/${id}`)).body.viewer).toEqual({ registered: true, inTeam: false });
      await as(t, users[0]!).delete(`/v1/tournaments/${id}/register`).expect(204);
      await as(t, users[0]!).delete(`/v1/tournaments/${id}/register`).expect(404);
      await as(t, null).post(`/v1/tournaments/${id}/register`, {}).expect(401);
    });

    it('respects closed registration, passwords and the Elo window', async () => {
      const closed = await create({ registrationOpen: false });
      expect((await as(t, users[0]!).post(`/v1/tournaments/${closed}/register`, {}).expect(409)).body.error).toBe('REGISTRATION_CLOSED');

      const secret = await create({ password: 'hunter22' });
      expect((await as(t, users[0]!).post(`/v1/tournaments/${secret}/register`, {}).expect(403)).body.error).toBe('WRONG_PASSWORD');
      await as(t, users[0]!).post(`/v1/tournaments/${secret}/register`, { password: 'wrong' }).expect(403);
      await as(t, users[0]!).post(`/v1/tournaments/${secret}/register`, { password: 'hunter22' }).expect(201);
      expect(JSON.stringify(await as(t, admin).get(`/v1/tournaments/${secret}`))).not.toContain('hunter22');

      const elite = await create({ name: 'Elite Cup', minElo: 1500 });
      expect((await as(t, users[1]!).post(`/v1/tournaments/${elite}/register`, {}).expect(403)).body.error).toBe('ELO_OUT_OF_RANGE');
      await t.prisma.playerRank.update({ where: { userId_mode: { userId: users[1]!.id, mode: 'FIVE_V_FIVE' } }, data: { elo: 1600, peakElo: 1600 } });
      await as(t, users[1]!).post(`/v1/tournaments/${elite}/register`, {}).expect(201);
    });

    it('refuses banned players', async () => {
      const id = await create();
      await t.prisma.ban.create({ data: { userId: users[0]!.id, type: 'PLATFORM', reason: 'cheating' } });
      expect((await as(t, users[0]!).post(`/v1/tournaments/${id}/register`, {}).expect(403)).body.error).toBe('PLAYER_BANNED');
    });
  });

  describe('teams', () => {
    it('auto-assign builds balanced teams from the registrations', async () => {
      const id = await create();
      const elos = [1500, 1400, 1300, 1200, 1100, 1000, 900, 800];
      for (const [i, u] of users.entries()) {
        await t.prisma.playerRank.update({ where: { userId_mode: { userId: u.id, mode: 'FIVE_V_FIVE' } }, data: { elo: elos[i]!, peakElo: elos[i]! } });
        await as(t, u).post(`/v1/tournaments/${id}/register`, {}).expect(201);
      }
      const res = await as(t, admin).post(`/v1/admin/tournaments/${id}/auto-assign`, { strategy: 'BALANCED' }).expect(201);
      expect(res.body.teams).toHaveLength(4);
      const teams = await t.prisma.tournamentTeam.findMany({ where: { tournamentId: id }, include: { members: true } });
      expect(teams.every((team) => team.members.length === 2 && team.members.some((m) => m.role === 'CAPTAIN'))).toBe(true);
      const averages = teams.map((team) => team.averageElo);
      expect(Math.max(...averages) - Math.min(...averages)).toBeLessThanOrEqual(200);
      expect((await t.prisma.tournamentRegistration.findMany({ where: { tournamentId: id } })).every((r) => r.status === 'ASSIGNED')).toBe(true);
    });

    it('assigns players to teams by hand and validates the groups', async () => {
      const id = await create();
      for (const u of users.slice(0, 4)) await as(t, u).post(`/v1/tournaments/${id}/register`, {}).expect(201);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/assign-players`, { teams: [{ name: 'Duo', userIds: [users[0]!.id, users[0]!.id] }] }).expect(400);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/assign-players`, { teams: [{ name: 'Outsider', userIds: [users[7]!.id, users[0]!.id] }] }).expect(400);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/assign-players`, { teams: [{ name: 'Four', userIds: [users[0]!.id, users[1]!.id, users[2]!.id, users[3]!.id] }] }).expect(400); // 2 starters + 1 substitute max
      const ok = await as(t, admin).post(`/v1/admin/tournaments/${id}/assign-players`, { teams: [{ name: 'Celtist Duo', userIds: [users[0]!.id, users[1]!.id] }] }).expect(201);
      expect(ok.body[0].members.map((m: { role: string }) => m.role)).toEqual(['CAPTAIN', 'MEMBER']);
    });

    it('lets the admin add, edit and remove teams manually, with optional substitute', async () => {
      const id = await create();
      const team = await as(t, admin)
        .post(`/v1/admin/tournaments/${id}/teams`, { name: 'Manual', members: [{ userId: users[0]!.id, role: 'CAPTAIN' }, { userId: users[1]!.id }, { userId: users[2]!.id, role: 'SUBSTITUTE' }] })
        .expect(201);
      expect(team.body.members).toHaveLength(3);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/teams`, { name: 'manual', members: [{ userId: users[3]!.id }] }).expect(409);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/teams`, { name: 'Overlap', members: [{ userId: users[0]!.id }] }).expect(409);
      await as(t, admin).patch(`/v1/admin/tournaments/${id}/teams/${team.body.id}`, { name: 'Renamed', seed: 1 }).expect(204);
      await as(t, admin).delete(`/v1/admin/tournaments/${id}/teams/${team.body.id}`).expect(204);
      expect(await t.prisma.tournamentTeam.count({ where: { tournamentId: id } })).toBe(0);
    });

    it('lets a team captain register a persistent team', async () => {
      const id = await create();
      const team = await t.prisma.team.create({ data: { name: 'Celtist Duo', nameKey: 'celtist duo', mode: 'FIVE_V_FIVE', captainId: users[0]!.id } });
      await t.prisma.teamMember.createMany({
        data: [
          { teamId: team.id, userId: users[0]!.id, mode: 'FIVE_V_FIVE', role: 'CAPTAIN' },
          { teamId: team.id, userId: users[1]!.id, mode: 'FIVE_V_FIVE', role: 'MEMBER' },
        ],
      });
      await as(t, users[1]!).post(`/v1/tournaments/${id}/register`, { teamId: team.id }).expect(403);
      const res = await as(t, users[0]!).post(`/v1/tournaments/${id}/register`, { teamId: team.id }).expect(201);
      expect(res.body.kind).toBe('TEAM');
      const entry = await t.prisma.tournamentTeam.findFirstOrThrow({ where: { tournamentId: id }, include: { members: true } });
      expect(entry).toMatchObject({ name: 'Celtist Duo', teamId: team.id });
      expect(entry.members).toHaveLength(2);
    });

    it('enforces the team limit', async () => {
      const id = await create({ maxTeams: 2 });
      for (let i = 0; i < 2; i++) {
        await as(t, admin).post(`/v1/admin/tournaments/${id}/teams`, { name: `T${i}`, members: [{ userId: users[i * 2]!.id, role: 'CAPTAIN' }, { userId: users[i * 2 + 1]!.id }] }).expect(201);
      }
      expect((await as(t, admin).post(`/v1/admin/tournaments/${id}/teams`, { name: 'T3', members: [{ userId: users[4]!.id }] }).expect(409)).body.error).toBe('TOURNAMENT_FULL');
    });
  });

  describe('running a tournament', () => {
    async function readyTournament(over: Record<string, unknown> = {}, teamCount = 4) {
      const id = await create(over);
      for (let i = 0; i < teamCount; i++) {
        await as(t, admin).post(`/v1/admin/tournaments/${id}/teams`, { name: `Team ${i + 1}`, members: [{ userId: users[i * 2]!.id, role: 'CAPTAIN' }, { userId: users[i * 2 + 1]!.id }] }).expect(201);
      }
      return id;
    }

    it('refuses to start without enough complete teams', async () => {
      const id = await create();
      const res = await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(409);
      expect(res.body.error).toBe('NOT_ENOUGH_TEAMS');
      await as(t, users[0]!).post(`/v1/admin/tournaments/${id}/start`).expect(403);
    });

    it('starts: seeds by Elo, builds the bracket, creates the matches and begins scheduling', async () => {
      const id = await readyTournament();
      await t.prisma.tournamentTeam.updateMany({ where: { tournamentId: id, name: 'Team 3' }, data: { averageElo: 1400 } });
      await driver.createServers(2);
      const res = await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(201);
      expect(res.body.matches).toBe(2);

      const teams = await t.prisma.tournamentTeam.findMany({ where: { tournamentId: id }, orderBy: { seed: 'asc' } });
      expect(teams[0]!.name).toBe('Team 3'); // highest Elo is seed 1
      const bracket = (await as(t, null).get(`/v1/tournaments/${id}/bracket`).expect(200)).body;
      expect(bracket.nodes).toHaveLength(3);
      expect(bracket.nodes.filter((n: { round: number }) => n.round === 1).map((n: { teamA: { seed: number }; teamB: { seed: number } }) => [n.teamA.seed, n.teamB.seed])).toEqual([[1, 4], [2, 3]]);
      expect((await t.prisma.tournament.findUniqueOrThrow({ where: { id } })).status).toBe('RUNNING');

      const firstRound = await t.prisma.match.findMany({ where: { tournamentMatch: { tournamentId: id, round: 1 } } });
      for (const m of firstRound) await driver.untilStatus(m.id, 'VETO'); // tournament matches continue into the veto on their own
      expect(await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(409));
    });

    it('plays a single-elimination tournament to its champion with Elo and placements', async () => {
      const id = await readyTournament();
      await driver.createServers(2);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(201);

      const node = async (key: string) => t.prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId: id, key }, include: { match: true } });
      for (const key of ['U1-0', 'U1-1']) await driver.play((await node(key)).matchId!, 'A');
      const final = await node('U2-0');
      expect(final.teamAId).not.toBeNull();
      expect(final.teamBId).not.toBeNull();
      // both finalists are known, so the final is waiting for a server or already has one
      expect(['WAITING', 'READY']).toContain((await as(t, null).get(`/v1/tournaments/${id}/bracket`)).body.nodes.find((n: { key: string }) => n.key === 'U2-0').status);

      await driver.play(final.matchId!, 'B');
      const done = await t.prisma.tournament.findUniqueOrThrow({ where: { id } });
      expect(done.status).toBe('FINISHED');
      const teams = await t.prisma.tournamentTeam.findMany({ where: { tournamentId: id }, orderBy: { placement: 'asc' } });
      expect(teams.map((x) => x.placement)).toEqual([1, 2, 3, 3]);
      expect(teams[0]!.id).toBe((await node('U2-0')).teamBId);

      // the winners of the final gained Elo, the losers lost; each player was rated exactly once per match played
      const champion = await t.prisma.tournamentTeam.findUniqueOrThrow({ where: { id: teams[0]!.id }, include: { members: true } });
      const rank = await t.prisma.playerRank.findUniqueOrThrow({ where: { userId_mode: { userId: champion.members[0]!.userId, mode: 'FIVE_V_FIVE' } } });
      expect(rank).toMatchObject({ wins: 2, losses: 0, matches: 2 });
      expect(rank.elo).toBeGreaterThan(1000);
      expect(await t.prisma.eloChange.count()).toBe(3 * 4);
    });

    it('plays a double-elimination tournament through the lower bracket', async () => {
      const id = await readyTournament({ format: 'DOUBLE_ELIMINATION', minTeams: 3 });
      await driver.createServers(2);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(201);

      const played = new Set<string>();
      for (let guard = 0; guard < 20; guard++) {
        const ready = await t.prisma.tournamentMatch.findMany({
          where: { tournamentId: id, match: { status: { in: ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'] }, teams: { some: {} } } },
          include: { match: { include: { teams: true } } },
        });
        const playable = ready.filter((n) => n.match!.teams.length === 2 && !played.has(n.key));
        if (playable.length === 0) break;
        const first = playable[0]!;
        await driver.play(first.matchId!, 'A');
        played.add(first.key);
      }
      expect((await t.prisma.tournament.findUniqueOrThrow({ where: { id } })).status).toBe('FINISHED');
      expect(played.size).toBe(6); // 2·4 − 2 games, the reset is not needed when the upper-bracket champion wins
      const nodes = await t.prisma.tournamentMatch.findMany({ where: { tournamentId: id }, include: { match: true } });
      expect(nodes.find((n) => n.key === 'GF-2')?.match?.status).toBe('CANCELLED');
      const placements = (await t.prisma.tournamentTeam.findMany({ where: { tournamentId: id } })).map((x) => x.placement).sort();
      expect(placements).toEqual([1, 2, 3, 4]);
    }, 60_000);

    it('pause stops new servers; resume continues; cancel closes everything', async () => {
      const id = await readyTournament();
      await driver.createServers(2);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/pause`).expect(409); // not running yet
      await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(201);
      const matches = await t.prisma.match.findMany({ where: { tournamentMatch: { tournamentId: id, round: 1 } } });
      await driver.untilStatus(matches[0]!.id, 'VETO');

      await as(t, admin).post(`/v1/admin/tournaments/${id}/pause`).expect(204);
      expect((await t.prisma.tournament.findUniqueOrThrow({ where: { id } })).status).toBe('PAUSED');
      await as(t, admin).post(`/v1/admin/tournaments/${id}/resume`).expect(204);

      await as(t, admin).post(`/v1/admin/tournaments/${id}/cancel`, { reason: 'server problems' }).expect(204);
      expect((await t.prisma.tournament.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
      expect(await t.prisma.match.count({ where: { tournamentMatch: { tournamentId: id }, status: { notIn: ['CANCELLED', 'FINISHED'] } } })).toBe(0);
      expect(await t.prisma.server.count({ where: { currentMatchId: { not: null } } })).toBe(0);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/cancel`, { reason: 'again please' }).expect(409);
    });

    it('an admin decision settles a no-show and advances the bracket without touching Elo', async () => {
      const id = await readyTournament();
      await driver.createServers(2);
      await as(t, admin).post(`/v1/admin/tournaments/${id}/start`).expect(201);
      const first = await t.prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId: id, key: 'U1-0' } });
      await as(t, admin).post(`/v1/admin/matches/${first.matchId}/decide`, { winner: 'B', reason: 'opponent did not show' }).expect(204);
      const after = await t.prisma.tournamentMatch.findUniqueOrThrow({ where: { id: first.id } });
      expect(after.winnerId).toBe(first.teamBId);
      expect(await t.prisma.eloChange.count()).toBe(0);
      expect((await t.prisma.tournamentMatch.findFirstOrThrow({ where: { tournamentId: id, key: 'U2-0' } })).teamAId).toBe(first.teamBId);
      await as(t, admin).post(`/v1/admin/matches/${first.matchId}/decide`, { winner: 'A', reason: 'changed my mind' }).expect(409);
    });
  });
});
