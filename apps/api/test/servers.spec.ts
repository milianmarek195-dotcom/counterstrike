import { Controller, Get, Post } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SIGNATURE_HEADERS, deriveServerKey, signRequest } from '@celtist/shared/signing';
import { DomainEvent } from '../src/common/domain-events.js';
import { ServerAllocator } from '../src/servers/server-allocator.service.js';
import { ServerHeartbeatService } from '../src/servers/server-heartbeat.service.js';
import { ServersService, effectiveStatus } from '../src/servers/servers.service.js';
import { ServersModule } from '../src/servers/servers.module.js';
import { ServerOnly } from '../src/security/access.js';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const MASTER = 'm'.repeat(48);

@Controller('server/v1/probe')
@ServerOnly()
class GatewayProbeController {
  @Get('whoami')
  whoami(): { ok: true } {
    return { ok: true };
  }

  @Post('echo')
  echo(): { ok: true } {
    return { ok: true };
  }
}

describe('servers', () => {
  let t: TestApp;
  let admin: TestUser;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ServersModule], controllers: [GatewayProbeController] });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['server_admin'] });
  });

  const nextPort = (() => {
    let port = 27000;
    return () => ++port;
  })();

  async function makeServer(over: Record<string, unknown> = {}) {
    return t.prisma.server.create({
      data: { name: `srv-${nextPort()}`, ip: '10.0.0.1', port: nextPort(), region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now(), ...over },
    });
  }
  const makeMatch = () => t.prisma.match.create({ data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE', status: 'WAITING' } });

  describe('admin management', () => {
    it('creates a server and shows the API key exactly once', async () => {
      const res = await as(t, admin).post('/v1/admin/servers', { name: 'EU #1', ip: '203.0.113.7', port: 27015, region: 'EU' }).expect(201);
      expect(res.body.apiKey).toMatch(/^[0-9a-f]{64}$/);
      expect(res.body.serverId).toBe(res.body.server.id);
      expect(res.body.server).toMatchObject({ name: 'EU #1', region: 'eu', status: 'OFFLINE', keyVersion: 1, maxPlayers: 12 });
      expect(JSON.stringify(await as(t, admin).get(`/v1/admin/servers/${res.body.serverId}`))).not.toContain(res.body.apiKey);
      expect(res.body.apiKey).toBe(deriveServerKey(MASTER, res.body.serverId, 1).toString('hex'));
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'server.create' } });
      expect(JSON.stringify(audit)).not.toContain(res.body.apiKey);
    });

    it('rejects invalid addresses and duplicates', async () => {
      await as(t, admin).post('/v1/admin/servers', { name: 'x', ip: 'not an ip!', port: 27015, region: 'eu' }).expect(400);
      await as(t, admin).post('/v1/admin/servers', { name: 'x', ip: '10.0.0.1', port: 70000, region: 'eu' }).expect(400);
      await as(t, admin).post('/v1/admin/servers', { name: 'a', ip: '10.0.0.5', port: 27015, region: 'eu' }).expect(201);
      await as(t, admin).post('/v1/admin/servers', { name: 'b', ip: '10.0.0.5', port: 27015, region: 'eu' }).expect(409);
      await as(t, admin).post('/v1/admin/servers', { name: 'c', ip: 'cs2.example.com', port: 27016, region: 'eu' }).expect(201);
    });

    it('splits permissions: view, manage and key rotation are separate', async () => {
      const viewer = await createUser(t, { roles: ['tournament_admin'] }); // has server.view only
      await as(t, viewer).get('/v1/admin/servers').expect(200);
      await as(t, viewer).post('/v1/admin/servers', { name: 'x', ip: '10.0.0.9', port: 27015, region: 'eu' }).expect(403);
      const server = await makeServer();
      await as(t, viewer).post(`/v1/admin/servers/${server.id}/rotate-key`).expect(403);
      await as(t, createUserless()).get('/v1/admin/servers').expect(401);
      const moderator = await createUser(t, { roles: ['moderator'] });
      await as(t, moderator).get('/v1/admin/servers').expect(403);
    });

    function createUserless() {
      return null;
    }

    it('rotating the key invalidates the old one at once', async () => {
      const created = await as(t, admin).post('/v1/admin/servers', { name: 'R', ip: '10.0.0.20', port: 27015, region: 'eu' }).expect(201);
      const oldKey = Buffer.from(created.body.apiKey, 'hex');
      await signedGet(created.body.serverId, oldKey, '/server/v1/probe/whoami').expect(200);

      const rotated = await as(t, admin).post(`/v1/admin/servers/${created.body.serverId}/rotate-key`).expect(201);
      expect(rotated.body.keyVersion).toBe(2);
      expect(rotated.body.apiKey).not.toBe(created.body.apiKey);
      await signedGet(created.body.serverId, oldKey, '/server/v1/probe/whoami').expect(401);
      await signedGet(created.body.serverId, Buffer.from(rotated.body.apiKey, 'hex'), '/server/v1/probe/whoami').expect(200);
    });

    it('updates settings, supports maintenance hold and refuses to delete a server in use', async () => {
      const server = await makeServer();
      const res = await as(t, admin).patch(`/v1/admin/servers/${server.id}`, { maintenanceHold: true, name: 'Renamed' }).expect(200);
      expect(res.body).toMatchObject({ maintenanceHold: true, name: 'Renamed' });
      const match = await makeMatch();
      await t.prisma.server.update({ where: { id: server.id }, data: { currentMatchId: match.id, status: 'IN_USE' } });
      const refused = await as(t, admin).delete(`/v1/admin/servers/${server.id}`).expect(409);
      expect(refused.body.error).toBe('SERVER_IN_USE');
      await t.prisma.server.update({ where: { id: server.id }, data: { currentMatchId: null } });
      await as(t, admin).delete(`/v1/admin/servers/${server.id}`).expect(204);
    });

    it('public listing hides addresses and reports silent servers as offline', async () => {
      const alive = await makeServer({ name: 'alive' });
      await makeServer({ name: 'silent', lastHeartbeatAt: new Date(t.clock.nowMs() - 60_000) });
      const res = await as(t, null).get('/v1/servers').expect(200);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.1');
      const byName = Object.fromEntries(res.body.servers.map((s: { name: string; status: string }) => [s.name, s.status]));
      expect(byName).toEqual({ alive: 'READY', silent: 'OFFLINE' });
      expect(res.body.servers.find((s: { id: string }) => s.id === alive.id)).not.toHaveProperty('ip');
    });
  });

  describe('allocation', () => {
    const allocator = () => t.app.get(ServerAllocator);

    it('reserves a ready server and marks it in use', async () => {
      const server = await makeServer();
      const match = await makeMatch();
      const reserved = await allocator().reserve(match.id);
      expect(reserved?.id).toBe(server.id);
      const row = await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } });
      expect(row).toMatchObject({ status: 'IN_USE', currentMatchId: match.id });
      expect(row.reservedUntil!.getTime()).toBeGreaterThan(t.clock.nowMs());
    });

    it('returns null when nothing is available', async () => {
      expect(await allocator().reserve((await makeMatch()).id)).toBeNull();
    });

    it('never hands out a server that is busy, silent, disabled, on hold or not ready', async () => {
      const busyMatch = await makeMatch();
      await makeServer({ status: 'IN_USE', currentMatchId: busyMatch.id });
      await makeServer({ lastHeartbeatAt: new Date(t.clock.nowMs() - 31_000) });
      await makeServer({ enabled: false });
      await makeServer({ maintenanceHold: true });
      await makeServer({ status: 'STARTING' });
      await makeServer({ status: 'ERROR' });
      await makeServer({ status: 'OFFLINE' });
      await makeServer({ lastHeartbeatAt: null });
      expect(await allocator().reserve((await makeMatch()).id)).toBeNull();
    });

    it('can be restricted to the servers of a tournament', async () => {
      const a = await makeServer();
      const b = await makeServer();
      const first = await allocator().reserve((await makeMatch()).id, { allowedServerIds: [b.id] });
      expect(first?.id).toBe(b.id);
      expect(await allocator().reserve((await makeMatch()).id, { allowedServerIds: [b.id] })).toBeNull();
      expect((await allocator().reserve((await makeMatch()).id))?.id).toBe(a.id);
    });

    it('never double-books under concurrency: 8 matches compete for 3 servers', async () => {
      const servers = await Promise.all([makeServer(), makeServer(), makeServer()]);
      const matches = await Promise.all(Array.from({ length: 8 }, makeMatch));
      const results = await Promise.all(matches.map((m) => allocator().reserve(m.id)));

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(3);
      expect(new Set(winners.map((w) => w!.id)).size).toBe(3); // three distinct servers
      const rows = await t.prisma.server.findMany({ where: { id: { in: servers.map((s) => s.id) } } });
      expect(rows.every((r) => r.status === 'IN_USE' && r.currentMatchId !== null)).toBe(true);
      expect(new Set(rows.map((r) => r.currentMatchId)).size).toBe(3); // three distinct matches
    });

    it('is idempotent per match: asking again returns the same server', async () => {
      const server = await makeServer();
      await makeServer();
      const match = await makeMatch();
      const first = await allocator().reserve(match.id);
      const second = await allocator().reserve(match.id);
      expect(first?.id).toBe(server.id);
      expect(second?.id).toBe(server.id);
      expect(await t.prisma.server.count({ where: { currentMatchId: match.id } })).toBe(1);
    });

    it('release frees the match but waits for the plugin before the server is READY again', async () => {
      const server = await makeServer();
      const match = await makeMatch();
      await allocator().reserve(match.id);
      expect(await allocator().release(match.id)).toBe(server.id);
      const row = await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } });
      expect(row.currentMatchId).toBeNull();
      expect(row.status).toBe('IN_USE'); // not allocatable until the heartbeat says idle
      expect(await allocator().reserve((await makeMatch()).id)).toBeNull();

      await t.app.get(ServerHeartbeatService).handle(server.id, beat({ status: 'READY' }));
      expect((await allocator().reserve((await makeMatch()).id))?.id).toBe(server.id);
      expect(await allocator().release('00000000-0000-7000-8000-000000000000')).toBeNull();
    });

    it('reservations expire if the match never goes live; going live pins them', async () => {
      const server = await makeServer();
      const match = await makeMatch();
      await allocator().reserve(match.id);
      expect(await allocator().findExpiredReservations()).toEqual([]);
      t.clock.advance(21 * 60_000);
      expect(await allocator().findExpiredReservations()).toEqual([{ serverId: server.id, matchId: match.id }]);

      await allocator().pinReservation(match.id);
      expect(await allocator().findExpiredReservations()).toEqual([]);
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).reservedUntil).toBeNull();
    });
  });

  describe('heartbeat', () => {
    const heartbeat = () => t.app.get(ServerHeartbeatService);

    it('brings a server online and records version, players and health', async () => {
      const server = await makeServer({ status: 'OFFLINE', lastHeartbeatAt: null });
      const events: unknown[] = [];
      t.app.get(EventEmitter2).on(DomainEvent.ServerStatus, (e) => events.push(e));

      const result = await heartbeat().handle(server.id, beat({ status: 'READY', players: 3, health: { tickrate: 64, map: 'de_dust2' } }));
      expect(result).toMatchObject({ pendingCommands: 0, expectedMatchId: null, skinsEnabled: false });
      const row = await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } });
      expect(row).toMatchObject({ status: 'READY', playerCount: 3, pluginVersion: '1.0.0', gameVersion: '1.41.8.4' });
      expect(row.health).toMatchObject({ tickrate: 64 });
      expect(row.lastHeartbeatAt!.getTime()).toBe(t.clock.nowMs());
      expect(events).toEqual([{ serverId: server.id, status: 'READY', previousStatus: 'OFFLINE' }]);
    });

    it('lets the backend reservation win over what the plugin reports', async () => {
      const server = await makeServer();
      const match = await makeMatch();
      await t.app.get(ServerAllocator).reserve(match.id);
      const result = await heartbeat().handle(server.id, beat({ status: 'READY' }));
      expect(result.expectedMatchId).toBe(match.id);
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).status).toBe('IN_USE');
    });

    it('shows maintenance-held servers as ONLINE and takes them out of the pool', async () => {
      const server = await makeServer({ maintenanceHold: true });
      await heartbeat().handle(server.id, beat({ status: 'READY' }));
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).status).toBe('ONLINE');
      expect(await t.app.get(ServerAllocator).reserve((await makeMatch()).id)).toBeNull();
    });

    it.each([['STARTING'], ['ERROR']] as const)('passes through %s', async (status) => {
      const server = await makeServer();
      await heartbeat().handle(server.id, beat({ status }));
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).status).toBe(status);
    });

    it('counts pending commands for the plugin', async () => {
      const server = await makeServer();
      await t.prisma.adminAction.create({
        data: { serverId: server.id, type: 'MATCH_PAUSE', expiresAt: new Date(t.clock.nowMs() + 60_000) },
      });
      await t.prisma.adminAction.create({
        data: { serverId: server.id, type: 'MATCH_PAUSE', expiresAt: new Date(t.clock.nowMs() - 60_000) }, // expired
      });
      expect((await heartbeat().handle(server.id, beat({ status: 'READY' }))).pendingCommands).toBe(1);
    });

    it('marks silent servers OFFLINE after 30 s and announces the affected match', async () => {
      const quiet = await makeServer();
      const alive = await makeServer();
      const match = await makeMatch();
      await t.prisma.server.update({ where: { id: quiet.id }, data: { currentMatchId: match.id, status: 'IN_USE' } });
      const offline: unknown[] = [];
      t.app.get(EventEmitter2).on(DomainEvent.ServerOffline, (e) => offline.push(e));

      t.clock.advance(20_000);
      await heartbeat().handle(alive.id, beat({ status: 'READY' }));
      expect(await heartbeat().markStaleOffline()).toBe(0);
      t.clock.advance(11_000);
      await heartbeat().handle(alive.id, beat({ status: 'READY' }));
      expect(await heartbeat().markStaleOffline()).toBe(1);

      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: quiet.id } })).status).toBe('OFFLINE');
      expect((await t.prisma.server.findUniqueOrThrow({ where: { id: alive.id } })).status).toBe('READY');
      expect(offline).toEqual([{ serverId: quiet.id, matchId: match.id }]);
    });

    it('flags a running match when the plugin forgot it (crash/restart)', async () => {
      const server = await makeServer();
      const match = await t.prisma.match.create({ data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE', status: 'LIVE' } });
      await t.prisma.server.update({ where: { id: server.id }, data: { currentMatchId: match.id, status: 'IN_USE' } });
      const lost: unknown[] = [];
      t.app.get(EventEmitter2).on(DomainEvent.ServerMatchLost, (e) => lost.push(e));

      await heartbeat().handle(server.id, beat({ status: 'READY', currentMatchId: null }));
      expect(lost).toEqual([{ serverId: server.id, matchId: match.id }]);
    });

    it('does not flag matches that have not been configured yet', async () => {
      const server = await makeServer();
      const match = await t.prisma.match.create({ data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE', status: 'LOBBY' } });
      await t.prisma.server.update({ where: { id: server.id }, data: { currentMatchId: match.id, status: 'IN_USE' } });
      const lost: unknown[] = [];
      t.app.get(EventEmitter2).on(DomainEvent.ServerMatchLost, (e) => lost.push(e));
      await heartbeat().handle(server.id, beat({ status: 'READY', currentMatchId: null }));
      expect(lost).toEqual([]);
    });

    it('orders a reset when the plugin keeps hosting a match the backend forgot', async () => {
      const server = await makeServer();
      const ghost = '0199b1f0-0000-7000-8000-0000000000aa';
      for (let i = 0; i < 5; i++) await heartbeat().handle(server.id, beat({ status: 'IN_USE', currentMatchId: ghost }));
      expect(await t.prisma.adminAction.count({ where: { serverId: server.id, type: 'MATCH_CANCEL' } })).toBe(0);
      await heartbeat().handle(server.id, beat({ status: 'IN_USE', currentMatchId: ghost }));
      const orders = await t.prisma.adminAction.findMany({ where: { serverId: server.id, type: 'MATCH_CANCEL' } });
      expect(orders).toHaveLength(1);
      expect(orders[0]!.payload).toMatchObject({ matchId: ghost, reason: 'STALE_MATCH' });
      // keeps reporting: no second order for the same match
      for (let i = 0; i < 12; i++) await heartbeat().handle(server.id, beat({ status: 'IN_USE', currentMatchId: ghost }));
      expect(await t.prisma.adminAction.count({ where: { serverId: server.id, type: 'MATCH_CANCEL' } })).toBe(1);
    });

    it('effectiveStatus treats silent servers as offline without waiting for the job', () => {
      const now = new Date('2026-10-02T12:00:00Z');
      expect(effectiveStatus({ status: 'READY', lastHeartbeatAt: new Date(now.getTime() - 29_000) }, now)).toBe('READY');
      expect(effectiveStatus({ status: 'READY', lastHeartbeatAt: new Date(now.getTime() - 31_000) }, now)).toBe('OFFLINE');
      expect(effectiveStatus({ status: 'IN_USE', lastHeartbeatAt: null }, now)).toBe('OFFLINE');
    });
  });

  describe('gateway authentication (signed requests)', () => {
    let server: { id: string; key: Buffer };

    beforeEach(async () => {
      const row = await makeServer();
      server = { id: row.id, key: deriveServerKey(MASTER, row.id, 1) };
    });

    it('accepts a correctly signed request', async () => {
      await signedGet(server.id, server.key, '/server/v1/probe/whoami').expect(200);
      await signedPost(server.id, server.key, '/server/v1/probe/echo', '{"hello":"world"}').expect(201);
    });

    it('rejects unsigned requests and cookie sessions', async () => {
      await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').expect(401);
      const user = await createUser(t, { roles: ['owner'] });
      const res = await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set('Cookie', user.cookie).expect(401);
      expect(res.body.error).toBe('INVALID_SIGNATURE');
    });

    it('rejects a wrong key, a tampered body and a tampered path', async () => {
      await signedGet(server.id, deriveServerKey(MASTER, server.id, 2), '/server/v1/probe/whoami').expect(401);
      await signedGet(server.id, deriveServerKey('x'.repeat(48), server.id, 1), '/server/v1/probe/whoami').expect(401);
      const headers = sign(server.id, server.key, 'POST', '/server/v1/probe/echo', '{"a":1}');
      await request(t.app.getHttpServer()).post('/server/v1/probe/echo').set(headers).set('content-type', 'application/json').send('{"a":2}').expect(401);
      const getHeaders = sign(server.id, server.key, 'GET', '/server/v1/probe/whoami');
      await request(t.app.getHttpServer()).get('/server/v1/probe/whoami?x=1').set(getHeaders).expect(401);
    });

    it('rejects replays of the same nonce', async () => {
      const headers = sign(server.id, server.key, 'GET', '/server/v1/probe/whoami');
      await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set(headers).expect(200);
      await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set(headers).expect(401);
    });

    it('rejects stale and future timestamps', async () => {
      for (const skew of [-31_000, 31_000]) {
        const headers = sign(server.id, server.key, 'GET', '/server/v1/probe/whoami', '', t.clock.nowMs() + skew);
        await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set(headers).expect(401);
      }
      const ok = sign(server.id, server.key, 'GET', '/server/v1/probe/whoami', '', t.clock.nowMs() + 25_000);
      await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set(ok).expect(200);
    });

    it('rejects unknown, disabled and malformed server ids with the same generic answer', async () => {
      const unknown = '0199b1f0-0000-7000-8000-0000000000ee';
      const a = await signedGet(unknown, deriveServerKey(MASTER, unknown, 1), '/server/v1/probe/whoami').expect(401);
      await t.prisma.server.update({ where: { id: server.id }, data: { enabled: false } });
      await t.redis.flushall();
      const b = await signedGet(server.id, server.key, '/server/v1/probe/whoami').expect(401);
      const headers = sign(server.id, server.key, 'GET', '/server/v1/probe/whoami');
      const c = await request(t.app.getHttpServer()).get('/server/v1/probe/whoami').set({ ...headers, [SIGNATURE_HEADERS.server]: 'not-a-uuid' }).expect(401);
      expect(a.body).toEqual(b.body.requestId ? { ...b.body, requestId: a.body.requestId } : b.body);
      expect(c.body.error).toBe('INVALID_SIGNATURE');
      expect(JSON.stringify([a.body, b.body, c.body])).not.toMatch(/signature mismatch|unknown server|disabled/i);
    });

    it('rate limits per server, not per address', async () => {
      const other = await makeServer();
      const otherKey = deriveServerKey(MASTER, other.id, 1);
      // the probe controller uses the default limit (300/min); exhaust it for one server only
      const key = `rl:global:srv:${server.id}`;
      await t.redis.set(key, '300', 'PX', 60_000);
      await signedGet(server.id, server.key, '/server/v1/probe/whoami').expect(429);
      await signedGet(other.id, otherKey, '/server/v1/probe/whoami').expect(200);
    });
  });

  function beat(over: Record<string, unknown> = {}) {
    return {
      status: 'READY' as const,
      currentMatchId: null,
      players: 0,
      version: '1.0.0',
      gameVersion: '1.41.8.4',
      timestampMs: t.clock.nowMs(),
      ...over,
    } as Parameters<ServerHeartbeatService['handle']>[1];
  }

  function sign(serverId: string, key: Buffer, method: string, path: string, body = '', timestampMs = t.clock.nowMs()) {
    const nonce = `n${Math.random().toString(36).slice(2)}${Date.now()}`;
    return {
      [SIGNATURE_HEADERS.server]: serverId,
      [SIGNATURE_HEADERS.timestamp]: String(timestampMs),
      [SIGNATURE_HEADERS.nonce]: nonce,
      [SIGNATURE_HEADERS.signature]: signRequest(key, { method, pathWithQuery: path, timestampMs, nonce, body }),
    };
  }
  function signedGet(serverId: string, key: Buffer, path: string) {
    return request(t.app.getHttpServer()).get(path).set(sign(serverId, key, 'GET', path));
  }
  function signedPost(serverId: string, key: Buffer, path: string, body: string) {
    return request(t.app.getHttpServer()).post(path).set(sign(serverId, key, 'POST', path, body)).set('content-type', 'application/json').send(body);
  }
});

// keep the unused-import checker honest
void ServersService;
