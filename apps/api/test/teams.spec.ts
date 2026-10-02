import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

describe('persistent teams', () => {
  let t: TestApp;
  let cap: TestUser;
  let mate: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'celtist-uploads-'));
    t = await createTestApp({ env: { UPLOAD_DIR: dir } });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    cap = await createUser(t, { displayName: 'Cap' });
    mate = await createUser(t, { displayName: 'Mate' });
    other = await createUser(t, { displayName: 'Other' });
  });

  async function newTeam(name = 'Alpha Squad') {
    return (await as(t, cap).post('/v1/teams', { name, tag: 'ALP' }).expect(201)).body.id as string;
  }
  async function joinTeam(id: string, user: TestUser) {
    await as(t, cap).post(`/v1/teams/${id}/invite`, { userId: user.id }).expect(204);
    const invite = (await as(t, user).get('/v1/teams/me')).body.invites[0];
    await as(t, user).post(`/v1/teams/invites/${invite.id}/accept`).expect(204);
  }

  it('creates a team with unique names and one team per player', async () => {
    const id = await newTeam();
    const view = (await as(t, cap).get(`/v1/teams/${id}`).expect(200)).body;
    expect(view.viewer.isCaptain).toBe(true);
    expect(view.members).toHaveLength(1);
    await as(t, cap).post('/v1/teams', { name: 'Second', tag: 'SEC' }).expect(409); // already in a team
    await as(t, mate).post('/v1/teams', { name: 'alpha squad' }).expect(409); // name taken, case-insensitive
    await as(t, mate).post('/v1/teams', { name: 'x' }).expect(400);
    await as(t, mate).post('/v1/teams', { name: 'Wing Duo', mode: 'WINGMAN' }).expect(400); // coming soon
    await as(t, null).post('/v1/teams', { name: 'Nope Team' }).expect(401);
    expect((await as(t, null).get('/v1/teams?q=alpha').expect(200)).body.teams).toHaveLength(1);
  });

  it('runs the invite flow, enforces captain rights and protects the captain role', async () => {
    const id = await newTeam();
    await joinTeam(id, mate);
    await as(t, mate).post(`/v1/teams/${id}/invite`, { userId: other.id }).expect(403);
    await as(t, cap).post(`/v1/teams/${id}/invite`, { userId: mate.id }).expect(409);
    await as(t, cap).post(`/v1/teams/${id}/leave`).expect(409);
    await as(t, cap).post(`/v1/teams/${id}/captain`, { userId: other.id }).expect(404);
    await as(t, cap).post(`/v1/teams/${id}/captain`, { userId: mate.id }).expect(204);
    await as(t, cap).post(`/v1/teams/${id}/kick`, { userId: mate.id }).expect(403);
    await as(t, cap).post(`/v1/teams/${id}/leave`).expect(204);
    await as(t, mate).post(`/v1/teams/${id}/kick`, { userId: mate.id }).expect(400);
    expect((await as(t, mate).get(`/v1/teams/${id}`)).body.members).toHaveLength(1);
  });

  it('declines invitations and does not let others answer them', async () => {
    const id = await newTeam();
    await as(t, cap).post(`/v1/teams/${id}/invite`, { steamId: mate.steamId }).expect(204);
    const invite = (await as(t, mate).get('/v1/teams/me')).body.invites[0];
    await as(t, other).post(`/v1/teams/invites/${invite.id}/accept`).expect(404);
    await as(t, mate).post(`/v1/teams/invites/${invite.id}/decline`).expect(204);
    await as(t, mate).post(`/v1/teams/invites/${invite.id}/accept`).expect(404);
  });

  it('accepts only real images as logos (magic bytes) and serves them', async () => {
    const id = await newTeam();
    const http = t.app.getHttpServer();
    const put = (user: TestUser, data: Buffer, name = 'logo.png') =>
      request(http).put(`/v1/teams/${id}/logo`).set('Cookie', user.cookie).set('X-CSRF-Token', user.csrf).set('Origin', 'http://localhost:3000').attach('file', data, name);
    await put(cap, Buffer.from('<svg onload=alert(1)>'), 'logo.png').expect(400);
    await put(mate, PNG).expect(403);
    await put(cap, PNG).expect(204);
    const res = await request(http).get(`/v1/teams/${id}/logo`).expect(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('disbands a team, freeing members and the name', async () => {
    const id = await newTeam();
    await joinTeam(id, mate);
    await as(t, mate).delete(`/v1/teams/${id}`).expect(403);
    await as(t, cap).delete(`/v1/teams/${id}`).expect(204);
    await as(t, cap).get(`/v1/teams/${id}`).expect(404);
    await newTeam('Alpha Squad'); // name is free again, captain is free again
  });
});
