import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('maps, pools and veto templates', () => {
  let t: TestApp;
  let admin: TestUser;
  let moderator: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['tournament_admin'] });
    moderator = await createUser(t, { roles: ['moderator'] });
  });

  it('serves the seeded default maps and pools publicly', async () => {
    const maps = await as(t, null).get('/v1/maps').expect(200);
    expect(maps.body.maps.map((m: { name: string }) => m.name)).toEqual([
      'Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Overpass', 'Dust2', 'Cache', 'Vertigo',
    ]);
    const wingman = await as(t, null).get('/v1/maps?mode=WINGMAN').expect(200);
    expect(wingman.body.maps.map((m: { key: string }) => m.key)).toEqual(['de_inferno', 'de_nuke', 'de_overpass', 'de_vertigo']);
    const pools = await as(t, null).get('/v1/map-pools').expect(200);
    expect(pools.body.pools).toHaveLength(2);
    expect(pools.body.pools.find((p: { mode: string }) => p.mode === 'FIVE_V_FIVE').maps).toHaveLength(9);
  });

  it('keeps maps configurable: nothing is hard-coded', async () => {
    const created = await as(t, admin).post('/v1/admin/maps', { key: 'de_train', name: 'Train', modes: ['FIVE_V_FIVE'] }).expect(201);
    expect(created.body).toMatchObject({ key: 'de_train', active: true });
    const list = await as(t, null).get('/v1/maps').expect(200);
    expect(list.body.maps.map((m: { key: string }) => m.key)).toContain('de_train');

    await as(t, admin).patch(`/v1/admin/maps/${created.body.id}`, { active: false }).expect(200);
    const after = await as(t, null).get('/v1/maps').expect(200);
    expect(after.body.maps.map((m: { key: string }) => m.key)).not.toContain('de_train');
  });

  it('requires the map.manage permission and records an audit entry', async () => {
    await as(t, null).post('/v1/admin/maps', { key: 'de_x', name: 'X', modes: ['WINGMAN'] }).expect(401);
    await as(t, moderator).post('/v1/admin/maps', { key: 'de_x', name: 'X', modes: ['WINGMAN'] }).expect(403);
    await as(t, admin).post('/v1/admin/maps', { key: 'de_x', name: 'X', modes: ['WINGMAN'] }).expect(201);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'map.create' } });
    expect(log.actorId).toBe(admin.id);
    expect(log.targetLabel).toBe('X');
    expect(log.newValue).toMatchObject({ key: 'de_x' });
  });

  it('validates map input', async () => {
    const bad = await as(t, admin).post('/v1/admin/maps', { key: 'Not Valid!', name: '', modes: [] }).expect(400);
    expect(bad.body.error).toBe('VALIDATION_FAILED');
    await as(t, admin).post('/v1/admin/maps', { key: 'de_mirage', name: 'Dup', modes: ['FIVE_V_FIVE'] }).expect(409);
    await as(t, admin)
      .post('/v1/admin/maps', { key: 'de_img', name: 'Img', modes: ['FIVE_V_FIVE'], imageUrl: 'http://insecure.example/x.png' })
      .expect(400);
  });

  it('refuses to delete maps that are in use', async () => {
    const mirage = await t.prisma.gameMap.findUniqueOrThrow({ where: { key: 'de_mirage' } });
    const res = await as(t, admin).delete(`/v1/admin/maps/${mirage.id}`).expect(409);
    expect(res.body.error).toBe('MAP_IN_USE');
    const fresh = await as(t, admin).post('/v1/admin/maps', { key: 'de_tmp', name: 'Tmp', modes: ['FIVE_V_FIVE'] }).expect(201);
    await as(t, admin).delete(`/v1/admin/maps/${fresh.body.id}`).expect(204);
  });

  it('creates pools, keeps one default per mode and checks map/mode compatibility', async () => {
    const maps = await t.prisma.gameMap.findMany();
    const five = maps.filter((m) => m.modes.includes('FIVE_V_FIVE')).slice(0, 5).map((m) => m.id);
    const created = await as(t, admin).post('/v1/admin/map-pools', { name: 'Small', mode: 'FIVE_V_FIVE', isDefault: true, mapIds: five }).expect(201);
    expect(created.body.isDefault).toBe(true);
    expect(await t.prisma.mapPool.count({ where: { mode: 'FIVE_V_FIVE', isDefault: true } })).toBe(1);

    const dust = maps.find((m) => m.key === 'de_dust2')!;
    const res = await as(t, admin).post('/v1/admin/map-pools', { name: 'Bad wingman', mode: 'WINGMAN', mapIds: [dust.id] }).expect(400);
    expect(res.body.error).toBe('MAP_MODE_MISMATCH');
    await as(t, admin).post('/v1/admin/map-pools', { name: 'Small', mode: 'FIVE_V_FIVE', mapIds: five }).expect(409);
    await as(t, admin).post('/v1/admin/map-pools', { name: 'Dups', mapIds: [five[0], five[0]] }).expect(400);
  });

  it('updates pool contents', async () => {
    const pool = await t.prisma.mapPool.findFirstOrThrow({ where: { mode: 'WINGMAN' }, include: { maps: true } });
    const keep = pool.maps.slice(0, 2).map((m) => m.mapId);
    const res = await as(t, admin).patch(`/v1/admin/map-pools/${pool.id}`, { mapIds: keep }).expect(200);
    expect(res.body.maps).toHaveLength(2);
    const log = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'map_pool.update' } });
    expect((log.oldValue as { mapIds: string[] }).mapIds).toHaveLength(4);
    expect((log.newValue as { mapIds: string[] }).mapIds).toHaveLength(2);
  });

  describe('veto templates', () => {
    const bo3 = [
      { action: 'BAN', team: 'A' }, { action: 'BAN', team: 'B' },
      { action: 'PICK', team: 'A' }, { action: 'SIDE', team: 'B' },
      { action: 'PICK', team: 'B' }, { action: 'SIDE', team: 'A' },
      { action: 'BAN', team: 'A' }, { action: 'BAN', team: 'B' },
      { action: 'DECIDER' }, { action: 'SIDE', team: 'A' },
    ];

    it('accepts a configurable order and lists it', async () => {
      const res = await as(t, admin).post('/v1/admin/veto-templates', { name: 'Classic BO3', bestOf: 3, steps: bo3, isDefault: true }).expect(201);
      expect(res.body.steps).toHaveLength(10);
      const list = await as(t, null).get('/v1/veto-templates').expect(200);
      expect(list.body.templates).toHaveLength(1);
    });

    it('rejects structurally invalid orders with the reasons', async () => {
      const res = await as(t, admin)
        .post('/v1/admin/veto-templates', { name: 'Broken', bestOf: 3, steps: [{ action: 'BAN', team: 'A' }, { action: 'DECIDER' }] })
        .expect(400);
      expect(res.body.error).toBe('INVALID_VETO_TEMPLATE');
      expect(res.body.details.join()).toMatch(/needs 2 picks/);
      await as(t, admin).post('/v1/admin/veto-templates', { name: 'BO7', bestOf: 7, steps: bo3 }).expect(400);
    });

    it('keeps one default per best-of and can be edited and deleted', async () => {
      const a = await as(t, admin).post('/v1/admin/veto-templates', { name: 'A', bestOf: 3, steps: bo3, isDefault: true }).expect(201);
      const b = await as(t, admin).post('/v1/admin/veto-templates', { name: 'B', bestOf: 3, steps: bo3, isDefault: true }).expect(201);
      expect(await t.prisma.vetoTemplate.count({ where: { bestOf: 3, isDefault: true } })).toBe(1);
      expect((await t.prisma.vetoTemplate.findUniqueOrThrow({ where: { id: a.body.id } })).isDefault).toBe(false);
      await as(t, admin).patch(`/v1/admin/veto-templates/${b.body.id}`, { name: 'B2' }).expect(200);
      await as(t, admin).delete(`/v1/admin/veto-templates/${a.body.id}`).expect(204);
      await as(t, admin).delete(`/v1/admin/veto-templates/${a.body.id}`).expect(404);
    });
  });
});
