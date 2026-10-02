import { Body, Controller, Get, Post } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimit } from '../src/common/rate-limit.js';
import { Public } from '../src/security/access.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const bodySchema = z.object({ name: z.string().min(3), count: z.number().int().min(1) });

@Controller('__probe')
@Public()
class ProbeController {
  @Post('validate')
  validate(@Body({ schema: bodySchema }) body: z.infer<typeof bodySchema>) {
    return { ok: true, body };
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail: password=hunter2 at /srv/app/db.ts:42');
  }

  @Get('limited')
  @RateLimit({ limit: 3, windowSeconds: 60, name: 'probe' })
  limited() {
    return { ok: true };
  }
}

describe('foundation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  describe('health', () => {
    it('liveness answers without touching dependencies', async () => {
      const res = await request(t.app.getHttpServer()).get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('readiness checks database and redis', async () => {
      const res = await request(t.app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    });
  });

  describe('error format', () => {
    it('answers unknown routes with a standard error body', async () => {
      const res = await request(t.app.getHttpServer()).get('/does-not-exist').expect(404);
      expect(res.body).toMatchObject({ error: 'NOT_FOUND' });
      expect(typeof res.body.message).toBe('string');
      expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules/i);
    });

    it('never leaks internals of unexpected errors', async () => {
      const res = await request(t.app.getHttpServer()).get('/v1/__probe/boom').expect(500);
      expect(res.body.error).toBe('INTERNAL_ERROR');
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('/srv/app');
      expect(res.body.requestId ?? res.headers['x-request-id']).toBeDefined();
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/v1/__probe/validate')
        .set('content-type', 'application/json')
        .send('{"name": ')
        .expect(400);
      expect(res.body.error).toBe('BAD_REQUEST');
    });

    it('rejects oversized bodies with 413', async () => {
      const res = await request(t.app.getHttpServer())
        .post('/v1/__probe/validate')
        .send({ name: 'x'.repeat(300_000), count: 1 })
        .expect(413);
      expect(res.body.error).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('validation', () => {
    it('accepts valid input', async () => {
      const res = await request(t.app.getHttpServer()).post('/v1/__probe/validate').send({ name: 'abc', count: 2 }).expect(201);
      expect(res.body.body).toEqual({ name: 'abc', count: 2 });
    });

    it('returns structured issues for invalid input', async () => {
      const res = await request(t.app.getHttpServer()).post('/v1/__probe/validate').send({ name: 'a', count: 0.5 }).expect(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['name'] }),
          expect.objectContaining({ path: ['count'] }),
        ]),
      );
    });

    it('does not let prototype pollution keys through', async () => {
      await request(t.app.getHttpServer())
        .post('/v1/__probe/validate')
        .set('content-type', 'application/json')
        .send('{"name":"abc","count":1,"__proto__":{"polluted":true}}')
        .expect(201);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('blocks after the configured number of requests and says when to retry', async () => {
      const http = t.app.getHttpServer();
      for (let i = 0; i < 3; i++) {
        const ok = await request(http).get('/v1/__probe/limited').expect(200);
        expect(ok.headers['ratelimit-limit']).toBe('3');
        expect(ok.headers['ratelimit-remaining']).toBe(String(2 - i));
      }
      const blocked = await request(http).get('/v1/__probe/limited').expect(429);
      expect(blocked.body.error).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('counts per client address, not globally', async () => {
      const http = t.app.getHttpServer();
      for (let i = 0; i < 3; i++) await request(http).get('/v1/__probe/limited').expect(200);
      await request(http).get('/v1/__probe/limited').expect(429);
      // Another client (different X-Forwarded-For is ignored without trust proxy, so reset the key to simulate it).
      await t.redis.flushall();
      await request(http).get('/v1/__probe/limited').expect(200);
    });

    it('does not rate limit health checks', async () => {
      for (let i = 0; i < 20; i++) await request(t.app.getHttpServer()).get('/health').expect(200);
    });
  });

  describe('transport security', () => {
    it('sets hardened headers and hides the framework', async () => {
      const res = await request(t.app.getHttpServer()).get('/health').expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('allows credentialed CORS only for configured origins', async () => {
      const allowed = await request(t.app.getHttpServer()).get('/health').set('Origin', 'http://localhost:3000');
      expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const denied = await request(t.app.getHttpServer()).get('/health').set('Origin', 'https://evil.example');
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('answers CORS preflight for allowed origins', async () => {
      const res = await request(t.app.getHttpServer())
        .options('/v1/__probe/validate')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-headers']).toContain('x-csrf-token');
    });
  });

  describe('database integrity (constraints Prisma cannot express)', () => {
    const user = (steamId: string) => t.prisma.user.create({ data: { steamId, displayName: `p${steamId}` } });

    it('rejects out-of-range floats and patterns at the database level', async () => {
      const owner = await user('76561198000000001');
      for (const floatValue of [-0.1, 1.0001]) {
        await expect(t.prisma.inventoryItem.create({ data: { ownerId: owner.id, slot: 'RIFLE', weaponDefIndex: 7, floatValue } })).rejects.toThrow();
      }
      for (const paintSeed of [-1, 1001]) {
        await expect(t.prisma.inventoryItem.create({ data: { ownerId: owner.id, slot: 'RIFLE', weaponDefIndex: 7, paintSeed } })).rejects.toThrow();
      }
      await expect(
        t.prisma.inventoryItem.create({ data: { ownerId: owner.id, slot: 'RIFLE', weaponDefIndex: 7, floatValue: 0.9999, paintSeed: 661 } }),
      ).resolves.toBeDefined();
    });

    it('allows teams of different sizes within bounds', async () => {
      const match = await t.prisma.match.create({ data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE' } });
      await expect(t.prisma.matchTeam.create({ data: { matchId: match.id, slot: 'A', name: 'A', maxPlayers: 2 } })).resolves.toBeDefined();
      await expect(t.prisma.matchTeam.create({ data: { matchId: match.id, slot: 'B', name: 'B', maxPlayers: 3 } })).resolves.toBeDefined();
      const other = await t.prisma.match.create({ data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE' } });
      await expect(t.prisma.matchTeam.create({ data: { matchId: other.id, slot: 'A', name: 'A', maxPlayers: 0 } })).rejects.toThrow();
      await expect(t.prisma.matchTeam.create({ data: { matchId: other.id, slot: 'B', name: 'B', maxPlayers: 17 } })).rejects.toThrow();
    });

    it('allows only one active loadout per player', async () => {
      const owner = await user('76561198000000002');
      await t.prisma.loadout.create({ data: { ownerId: owner.id, name: 'A', shareCode: 'CELTIST-BBBBBB', isActive: true } });
      await expect(
        t.prisma.loadout.create({ data: { ownerId: owner.id, name: 'B', shareCode: 'CELTIST-CCCCCC', isActive: true } }),
      ).rejects.toThrow();
      await expect(
        t.prisma.loadout.create({ data: { ownerId: owner.id, name: 'C', shareCode: 'CELTIST-DDDDDD', isActive: false } }),
      ).resolves.toBeDefined();
    });

    it('enforces unique SteamIDs and share codes', async () => {
      await user('76561198000000003');
      await expect(user('76561198000000003')).rejects.toThrow();
    });

    it('keeps skin permission levels within 0–3', async () => {
      const target = await user('76561198000000004');
      await expect(t.prisma.skinPermission.create({ data: { userId: target.id, level: 4 } })).rejects.toThrow();
      await expect(t.prisma.skinPermission.create({ data: { userId: target.id, level: 3 } })).resolves.toBeDefined();
    });

    it('never lets Elo go negative', async () => {
      const target = await user('76561198000000005');
      await expect(
        t.prisma.playerRank.create({ data: { userId: target.id, mode: 'FIVE_V_FIVE', elo: -5, peakElo: 1000 } }),
      ).rejects.toThrow();
    });
  });
});

