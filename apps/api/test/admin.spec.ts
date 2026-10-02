import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('admin module', () => {
  let t: TestApp;
  let owner: TestUser;
  let mod: TestUser;
  let player: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    owner = await createUser(t, { roles: ['owner'] });
    mod = await createUser(t, { roles: ['moderator'] });
    player = await createUser(t, { displayName: 'Victim' });
  });

  it('rejects anonymous and unprivileged access', async () => {
    await as(t, null).get('/v1/admin/dashboard').expect(401);
    await as(t, player).get('/v1/admin/dashboard').expect(403);
    await as(t, player).get('/v1/admin/players').expect(403);
    const res = await as(t, owner).get('/v1/admin/dashboard').expect(200);
    expect(res.body).toHaveProperty('servers');
    expect(res.body).toHaveProperty('activeMatches');
  });

  it('searches players and shows details', async () => {
    const list = await as(t, owner).get('/v1/admin/players?q=Victim').expect(200);
    expect(list.body.players).toHaveLength(1);
    const detail = await as(t, owner).get(`/v1/admin/players/${player.id}`).expect(200);
    expect(detail.body.steamId).toBe(player.steamId);
    await as(t, owner).get('/v1/admin/players/not-a-uuid').expect(400);
  });

  it('changes Elo with an audit entry and sets rank by tier', async () => {
    await as(t, owner).post(`/v1/admin/players/${player.id}/elo`, { mode: 'FIVE_V_FIVE', elo: 1800, reason: 'manual fix' }).expect(201);
    const rank = await t.prisma.playerRank.findFirstOrThrow({ where: { userId: player.id, mode: 'FIVE_V_FIVE' } });
    expect(rank.elo).toBe(1800);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'player.elo.set' } });
    expect(log.targetId).toBe(player.id);
    expect(log.reason).toBe('manual fix');
    await as(t, mod).post(`/v1/admin/players/${player.id}/elo`, { mode: 'FIVE_V_FIVE', elo: 5, reason: 'x' }).expect(403);
  });

  it('bans, ends sessions and unbans; admins cannot be banned', async () => {
    await as(t, owner).post('/v1/admin/bans', { userId: player.id, reason: 'cheating', durationHours: 24 }).expect(201);
    expect((await as(t, player).get('/v1/auth/me').expect(200)).body.user).toBeNull();
    const bans = await as(t, owner).get('/v1/admin/bans?active=true').expect(200);
    expect(bans.body.bans).toHaveLength(1);
    await as(t, owner).post(`/v1/admin/players/${player.id}/unban`, { reason: 'appeal' }).expect(204);
    await as(t, owner).post(`/v1/admin/players/${player.id}/unban`, { reason: 'again' }).expect(409);
    await as(t, owner).post('/v1/admin/bans', { userId: owner.id, reason: 'self ban test' }).expect(400);
    await as(t, owner).post('/v1/admin/bans', { userId: mod.id, reason: 'admin ban test' }).expect(403);
  });

  it('protects the last owner and applies role changes immediately', async () => {
    await as(t, owner).put(`/v1/admin/players/${owner.id}/roles`, { roleKeys: ['moderator'], reason: 'demote' }).expect(403);
    await as(t, owner).put(`/v1/admin/players/${player.id}/roles`, { roleKeys: ['moderator'], reason: 'promote' }).expect(204);
    await as(t, player).get('/v1/admin/dashboard').expect(200);
    await as(t, owner).put(`/v1/admin/players/${player.id}/roles`, { roleKeys: [], reason: 'remove' }).expect(204);
    await as(t, player).get('/v1/admin/dashboard').expect(403);
    await as(t, owner).put(`/v1/admin/players/${player.id}/roles`, { roleKeys: ['nope'], reason: 'bad' }).expect(400);
  });

  it('manages custom roles and protects system roles', async () => {
    const created = await as(t, owner).post('/v1/admin/roles', { key: 'helper', name: 'Helper', permissions: ['player.view'] }).expect(201);
    await as(t, owner).post('/v1/admin/roles', { key: 'helper', name: 'Dup', permissions: [] }).expect(409);
    await as(t, owner).post('/v1/admin/roles', { key: 'bad', name: 'Bad', permissions: ['does.not.exist'] }).expect(400);
    await as(t, owner).patch(`/v1/admin/roles/${created.body.id}`, { permissions: ['player.view', 'audit.view'] }).expect(204);
    const roles = (await as(t, owner).get('/v1/admin/roles').expect(200)).body.roles as Array<{ id: string; key: string; isSystem: boolean }>;
    const ownerRole = roles.find((r) => r.key === 'owner')!;
    await as(t, owner).patch(`/v1/admin/roles/${ownerRole.id}`, { permissions: ['player.view'] }).expect(403);
    await as(t, owner).delete(`/v1/admin/roles/${ownerRole.id}`).expect(403);
    await as(t, owner).delete(`/v1/admin/roles/${created.body.id}`).expect(204);
  });

  it('queries the audit log by action', async () => {
    await as(t, owner).post(`/v1/admin/players/${player.id}/elo`, { mode: 'FIVE_V_FIVE', elo: 1200, reason: 'audit test' }).expect(201);
    const res = await as(t, owner).get('/v1/admin/audit?action=player.elo').expect(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    await as(t, player).get('/v1/admin/audit').expect(403);
  });

  it('validates and replaces rank tiers', async () => {
    await as(t, owner).put('/v1/admin/rank-tiers', { tiers: [] }).expect(400);
    const tiers = [
      { key: 'low', name: 'Low', minElo: 0, color: '#888888' },
      { key: 'high', name: 'High', minElo: 1500, color: '#ffcc00' },
    ];
    await as(t, owner).put('/v1/admin/rank-tiers', { tiers }).expect(200);
    expect(await t.prisma.rankTier.count()).toBe(2);
    await as(t, owner).put('/v1/admin/rank-tiers', { tiers: [{ key: 'x', name: 'X', minElo: 100, color: '#111111' }] }).expect(400); // must start at 0
  });

  it('stores webhook URLs encrypted and only returns them masked', async () => {
    const url = 'https://discord.com/api/webhooks/123/secret-token-abcd';
    const res = await as(t, owner).post('/v1/admin/webhooks', { name: 'Main', url, events: ['match.finished'], enabled: true }).expect(201);
    const row = await t.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.urlEncrypted).not.toContain('secret-token');
    const list = (await as(t, owner).get('/v1/admin/webhooks').expect(200)).body.webhooks;
    expect(JSON.stringify(list)).not.toContain('secret-token');
    expect(list[0].url).toContain('abcd');
    await as(t, owner).post('/v1/admin/webhooks', { name: 'Bad', url: 'http://evil.example/x', events: ['match.finished'] }).expect(400);
    await as(t, owner).delete(`/v1/admin/webhooks/${res.body.id}`).expect(204);
  });
});
