import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MatchTicker } from '../src/matches/match-ticker.service.js';
import { leadingSlot } from '../src/matches/match-time-limit.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('match time limit', () => {
  let t: TestApp;
  const MIN = 60_000;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function match(over: { status: 'LIVE' | 'LOBBY'; startedMinutesAgo?: number; createdMinutesAgo?: number; kind?: 'CUSTOM' | 'TOURNAMENT'; serverId?: string }) {
    const now = t.clock.nowMs();
    return t.prisma.match.create({
      data: {
        kind: over.kind ?? 'CUSTOM',
        mode: 'FIVE_V_FIVE',
        status: over.status,
        bestOf: 1,
        serverId: over.serverId ?? null,
        startedAt: over.startedMinutesAgo !== undefined ? new Date(now - over.startedMinutesAgo * MIN) : null,
        createdAt: new Date(now - (over.createdMinutesAgo ?? over.startedMinutesAgo ?? 0) * MIN),
        teams: { create: [{ slot: 'A', name: 'A' }, { slot: 'B', name: 'B' }] },
      },
    });
  }
  const tick = () => t.app.get(MatchTicker).runOnce();
  const status = async (id: string) => (await t.prisma.match.findUniqueOrThrow({ where: { id } })).status;

  it('cancels a party match that has been running longer than 90 minutes and keeps younger ones', async () => {
    const old = await match({ status: 'LIVE', startedMinutesAgo: 95 });
    const young = await match({ status: 'LIVE', startedMinutesAgo: 80 });
    const result = await tick();
    expect(result.timeLimited).toBe(1);
    expect(await status(old.id)).toBe('CANCELLED');
    expect((await t.prisma.match.findUniqueOrThrow({ where: { id: old.id } })).cancelReason).toContain('90 Minuten');
    expect(await status(young.id)).toBe('LIVE');
  });

  it('frees the server and tells it to stop', async () => {
    const server = await t.prisma.server.create({ data: { name: 'S', ip: '10.9.0.1', port: 27015, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now() } });
    const m = await match({ status: 'LIVE', startedMinutesAgo: 100, serverId: server.id });
    await t.prisma.server.update({ where: { id: server.id }, data: { currentMatchId: m.id } });
    await tick();
    expect(await status(m.id)).toBe('CANCELLED');
    expect((await t.prisma.server.findUniqueOrThrow({ where: { id: server.id } })).currentMatchId).toBeNull();
    expect(await t.prisma.adminAction.count({ where: { serverId: server.id, type: 'MATCH_CANCEL' } })).toBe(1);
  });

  it('also closes a forgotten lobby after 90 minutes, but never touches a fresh one', async () => {
    const forgotten = await match({ status: 'LOBBY', createdMinutesAgo: 120 });
    const fresh = await match({ status: 'LOBBY', createdMinutesAgo: 10 });
    await tick();
    expect(await status(forgotten.id)).toBe('CANCELLED');
    expect(await status(fresh.id)).toBe('LOBBY');
  });

  it('can be switched off or set to another length', async () => {
    const m = await match({ status: 'LIVE', startedMinutesAgo: 200 });
    const settings = t.app.get(SettingsService);
    await settings.set('match.maxDurationMinutes', 0, null);
    expect((await tick()).timeLimited).toBe(0);
    expect(await status(m.id)).toBe('LIVE');
    await settings.set('match.maxDurationMinutes', 240, null);
    expect((await tick()).timeLimited).toBe(0);
    await settings.set('match.maxDurationMinutes', 120, null);
    expect((await tick()).timeLimited).toBe(1);
    expect(await status(m.id)).toBe('CANCELLED');
  });

  it('leaves a level tournament match to the admins instead of cancelling it', async () => {
    const m = await match({ status: 'LIVE', startedMinutesAgo: 120, kind: 'TOURNAMENT' });
    const result = await tick();
    expect(result.timeLimited).toBe(0);
    expect(await status(m.id)).toBe('LIVE');
  });

  describe('leadingSlot', () => {
    it('uses the series score first, then the running map, and is null when level', () => {
      expect(leadingSlot([{ slot: 'A', seriesScore: 1 }, { slot: 'B', seriesScore: 0 }], { scoreA: 2, scoreB: 9 })).toBe('A');
      expect(leadingSlot([{ slot: 'A', seriesScore: 0 }, { slot: 'B', seriesScore: 0 }], { scoreA: 5, scoreB: 9 })).toBe('B');
      expect(leadingSlot([{ slot: 'A', seriesScore: 0 }, { slot: 'B', seriesScore: 0 }], { scoreA: 7, scoreB: 7 })).toBeNull();
      expect(leadingSlot([{ slot: 'A', seriesScore: 0 }, { slot: 'B', seriesScore: 0 }], null)).toBeNull();
    });
  });
});
