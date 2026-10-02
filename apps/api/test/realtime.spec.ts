import type { AddressInfo } from 'node:net';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('realtime gateway', () => {
  let t: TestApp;
  let url: string;
  let admin: TestUser;
  let player: TestUser;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    await t.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['owner'] });
    player = await createUser(t, {});
  });

  async function open(user: TestUser | null, origin = 'http://localhost:3000'): Promise<Socket> {
    const s = connect(url, { path: '/realtime', transports: ['websocket'], extraHeaders: { ...(user ? { cookie: user.cookie } : {}), origin }, reconnection: false });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  }
  const next = (s: Socket) => new Promise<Record<string, unknown>>((resolve) => s.once('event', resolve));
  const emit = (name: string, payload: object) => t.app.get(EventEmitter2).emit(name, payload);
  const ack = (s: Socket, msg: object) => s.emitWithAck('subscribe', msg) as Promise<{ ok: boolean; error?: string }>;

  it('pushes match events only to subscribed rooms and strips detail', async () => {
    const a = await open(null);
    const b = await open(null);
    const matchId = crypto.randomUUID();
    expect((await ack(a, { room: 'match', id: matchId })).ok).toBe(true);
    const got = next(a);
    emit('match.updated', { matchId, secret: 'should-not-leak' });
    const event = await got;
    expect(event).toMatchObject({ event: 'match.updated', matchId });
    expect(JSON.stringify(event)).not.toContain('should-not-leak');
    let leaked = false;
    b.once('event', () => (leaked = true));
    await new Promise((r) => setTimeout(r, 150));
    expect(leaked).toBe(false);
  });

  it('restricts the servers room to permitted users and validates subscriptions', async () => {
    const anon = await open(null);
    const p = await open(player);
    const a = await open(admin);
    expect((await ack(anon, { room: 'servers' })).error).toBe('FORBIDDEN');
    expect((await ack(p, { room: 'servers' })).error).toBe('FORBIDDEN');
    expect((await ack(a, { room: 'servers' })).ok).toBe(true);
    expect((await ack(a, { room: 'match' })).ok).toBe(false);
    expect((await ack(a, { room: 'nope' })).ok).toBe(false);
    const got = next(a);
    emit('server.status', { serverId: crypto.randomUUID(), status: 'IDLE' });
    expect((await got).event).toBe('server.status');
  });

  it('delivers personal events to the signed-in user only', async () => {
    const p = await open(player);
    const q = await open(admin);
    const got = next(p);
    let leaked = false;
    q.once('event', () => (leaked = true));
    emit('notification.created', { userId: player.id, notificationId: 'n1' });
    expect((await got).event).toBe('notification.created');
    await new Promise((r) => setTimeout(r, 150));
    expect(leaked).toBe(false);
  });

  it('rejects connections from foreign origins', async () => {
    const s = connect(url, { path: '/realtime', transports: ['websocket'], extraHeaders: { origin: 'https://evil.example' }, reconnection: false });
    sockets.push(s);
    const reason = await new Promise<string>((resolve) => s.once('disconnect', resolve));
    expect(reason).toBeTruthy();
  });
});
