import { describe, expect, it } from 'vitest';
import {
  eventBatchSchema,
  heartbeatSchema,
  mapResultSchema,
  mapsToWin,
  roundsToWin,
  seriesState,
  skinCommandSchema,
  validateMapResult,
  type MapResultInput,
  type MapResultPayload,
  type ResultValidationContext,
} from '../src/index.js';

const MATCH_ID = '0199b1f0-0000-7000-8000-000000000001';
const NOW = Date.parse('2026-10-02T14:00:00Z');

const teamA = ['76561198000000001', '76561198000000002', '76561198000000003', '76561198000000004', '76561198000000005'];
const teamB = ['76561198000000011', '76561198000000012', '76561198000000013', '76561198000000014', '76561198000000015'];

const ctx = (over: Partial<ResultValidationContext> = {}): ResultValidationContext => ({
  matchId: MATCH_ID,
  expectedMapNumber: 1,
  roster: [...teamA.map((steamId) => ({ steamId, team: 'A' as const })), ...teamB.map((steamId) => ({ steamId, team: 'B' as const }))],
  roundsToWin: 13,
  allowDraw: false,
  nowMs: NOW,
  maxClockSkewMs: 30_000,
  ...over,
});

const player = (steamId: string, team: 'A' | 'B', over: Record<string, number> = {}) => ({
  steamId,
  team,
  rounds: 24,
  kills: 15,
  deaths: 12,
  assists: 4,
  headshots: 6,
  damage: 1800,
  mvps: 3,
  ...over,
});

function report(over: Partial<MapResultInput> = {}): MapResultPayload {
  return mapResultSchema.parse({
    matchId: MATCH_ID,
    mapNumber: 1,
    idempotencyKey: 'result-0001-abcdef',
    scoreA: 13,
    scoreB: 11,
    rounds: 24,
    startedAt: '2026-10-02T13:10:00Z',
    endedAt: '2026-10-02T13:55:00Z',
    players: [...teamA.map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
    ...over,
  });
}

const errorsOf = (result: ReturnType<typeof validateMapResult>): string[] => (result.ok ? [] : result.errors);
const has = (result: ReturnType<typeof validateMapResult>, code: string): boolean =>
  errorsOf(result).some((e) => e.startsWith(code));

describe('validateMapResult', () => {
  it('accepts a consistent result and names the winner', () => {
    const result = validateMapResult(ctx(), report());
    expect(result).toMatchObject({ ok: true, winner: 'A' });
    const shorter = report({
      scoreA: 9,
      scoreB: 13,
      rounds: 22,
      players: [...teamA.map((id) => player(id, 'A', { rounds: 22 })), ...teamB.map((id) => player(id, 'B', { rounds: 22 }))],
    });
    expect(validateMapResult(ctx(), shorter)).toMatchObject({ ok: true, winner: 'B' });
  });

  it('accepts overtime scores', () => {
    expect(validateMapResult(ctx(), report({ scoreA: 16, scoreB: 13, rounds: 29 }))).toMatchObject({ ok: true, winner: 'A' });
  });

  it('rejects results for another match or the wrong map', () => {
    expect(has(validateMapResult(ctx(), report({ matchId: '0199b1f0-0000-7000-8000-0000000000ff' })), 'MATCH_MISMATCH')).toBe(true);
    expect(has(validateMapResult(ctx({ expectedMapNumber: 2 }), report()), 'MAP_NUMBER_MISMATCH')).toBe(true);
  });

  it('rejects scores that do not add up to the rounds', () => {
    expect(has(validateMapResult(ctx(), report({ rounds: 30 })), 'ROUNDS_MISMATCH')).toBe(true);
  });

  it('rejects draws unless allowed', () => {
    const draw = report({ scoreA: 12, scoreB: 12, rounds: 24 });
    expect(has(validateMapResult(ctx(), draw), 'DRAW_NOT_ALLOWED')).toBe(true);
    const ok = validateMapResult(ctx({ allowDraw: true }), report({ scoreA: 12, scoreB: 12, rounds: 24, endReason: 'ADMIN' }));
    expect(ok).toMatchObject({ ok: true, winner: null });
  });

  it('rejects normal finishes without a plausible winning score', () => {
    expect(has(validateMapResult(ctx(), report({ scoreA: 7, scoreB: 5, rounds: 12 })), 'SCORE_IMPLAUSIBLE')).toBe(true);
    // Wingman is first to 9
    const wingman = validateMapResult(
      ctx({ roundsToWin: 9, roster: [{ steamId: teamA[0]!, team: 'A' }, { steamId: teamB[0]!, team: 'B' }] }),
      report({ scoreA: 9, scoreB: 4, rounds: 13, players: [player(teamA[0]!, 'A', { rounds: 13, damage: 900 }), player(teamB[0]!, 'B', { rounds: 13, damage: 900 })] }),
    );
    expect(wingman.ok).toBe(true);
  });

  it('accepts early endings when the reason says so (forfeit/admin)', () => {
    const forfeit = report({
      scoreA: 13,
      scoreB: 2,
      rounds: 15,
      endReason: 'FORFEIT',
      endedAt: '2026-10-02T13:12:00Z',
      players: [...teamA.map((id) => player(id, 'A', { rounds: 15, mvps: 2 })), ...teamB.map((id) => player(id, 'B', { rounds: 15, mvps: 1 }))],
    });
    expect(validateMapResult(ctx(), forfeit).ok).toBe(true);
  });

  it('rejects impossible timing', () => {
    expect(has(validateMapResult(ctx(), report({ startedAt: '2026-10-02T13:55:00Z', endedAt: '2026-10-02T13:10:00Z' })), 'TIME_TRAVEL')).toBe(true);
    expect(has(validateMapResult(ctx(), report({ endedAt: '2026-10-02T14:05:00Z' })), 'FUTURE_END')).toBe(true);
    expect(
      has(validateMapResult(ctx(), report({ startedAt: '2026-10-02T13:54:00Z', endedAt: '2026-10-02T13:55:00Z' })), 'DURATION_IMPLAUSIBLE'),
    ).toBe(true);
  });

  it('tolerates small clock skew on the end time', () => {
    expect(validateMapResult(ctx(), report({ endedAt: '2026-10-02T14:00:20Z' })).ok).toBe(true);
  });

  it('rejects players that are not part of the match (the key anti-cheat rule)', () => {
    const stranger = report({ players: [...teamA.map((id) => player(id, 'A')), player('76561198999999999', 'B'), ...teamB.slice(1).map((id) => player(id, 'B'))] });
    expect(has(validateMapResult(ctx(), stranger), 'UNKNOWN_PLAYER')).toBe(true);
  });

  it('rejects players reported for the wrong team', () => {
    const swapped = report({ players: [player(teamA[0]!, 'B'), ...teamA.slice(1).map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))] });
    expect(has(validateMapResult(ctx(), swapped), 'WRONG_TEAM')).toBe(true);
  });

  it('rejects duplicate players', () => {
    const dup = report({ players: [player(teamA[0]!, 'A'), player(teamA[0]!, 'A'), ...teamB.map((id) => player(id, 'B'))] });
    expect(has(validateMapResult(ctx(), dup), 'DUPLICATE_PLAYER')).toBe(true);
  });

  it('requires both teams to be represented', () => {
    expect(has(validateMapResult(ctx(), report({ players: teamA.map((id) => player(id, 'A')) })), 'MISSING_TEAM')).toBe(true);
  });

  it.each([
    ['headshots above kills', { headshots: 20, kills: 10 }, 'HEADSHOTS'],
    ['more rounds than the map', { rounds: 40 }, 'PLAYER_ROUNDS'],
    ['more MVPs than rounds', { mvps: 30 }, 'MVPS'],
    ['absurd damage', { damage: 90_000 }, 'DAMAGE'],
    ['utility above total damage', { utilityDamage: 5000 }, 'UTILITY_DAMAGE'],
    ['entry kills above kills', { entryKills: 99, kills: 5, headshots: 1 }, 'ENTRY_KILLS'],
    ['entry deaths above deaths', { entryDeaths: 99 }, 'ENTRY_DEATHS'],
    ['clutches above rounds', { clutches: 99 }, 'CLUTCHES'],
    ['absurd kill counts', { kills: 400, headshots: 1 }, 'KILLS'],
  ])('rejects a player with %s', (_label, over, code) => {
    const bad = report({
      players: [player(teamA[0]!, 'A', over), ...teamA.slice(1).map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
    });
    expect(has(validateMapResult(ctx(), bad), code)).toBe(true);
  });

  it('flags suspicious but possible kill/death totals without rejecting', () => {
    const inflated = report({
      players: [...teamA.map((id) => player(id, 'A', { kills: 25 })), ...teamB.map((id) => player(id, 'B', { deaths: 10 }))],
    });
    const result = validateMapResult(ctx(), inflated);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.anomalies.join()).toMatch(/Team A kills/);
  });

  it('reports every problem at once, not just the first', () => {
    const bad = report({ mapNumber: 3, scoreA: 5, scoreB: 5, rounds: 11, players: [player('76561198999999999', 'A')] });
    expect(errorsOf(validateMapResult(ctx(), bad)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('series', () => {
  it('computes maps needed to win', () => {
    expect([1, 3, 5].map((n) => mapsToWin(n as 1 | 3 | 5))).toEqual([1, 2, 3]);
  });

  it('BO1 ends after one map', () => {
    expect(seriesState(1, [])).toMatchObject({ winner: null, nextMapNumber: 1 });
    expect(seriesState(1, ['B'])).toMatchObject({ winner: 'B', nextMapNumber: null });
  });

  it('BO3 ends at 2–0 or 2–1', () => {
    expect(seriesState(3, ['A'])).toMatchObject({ winner: null, nextMapNumber: 2, winsA: 1 });
    expect(seriesState(3, ['A', 'A'])).toMatchObject({ winner: 'A', nextMapNumber: null });
    expect(seriesState(3, ['A', 'B'])).toMatchObject({ winner: null, nextMapNumber: 3 });
    expect(seriesState(3, ['A', 'B', 'B'])).toMatchObject({ winner: 'B', nextMapNumber: null });
  });

  it('BO5 needs three maps', () => {
    expect(seriesState(5, ['A', 'A', 'B', 'B'])).toMatchObject({ winner: null, nextMapNumber: 5 });
    expect(seriesState(5, ['A', 'A', 'B', 'B', 'A'])).toMatchObject({ winner: 'A' });
    expect(seriesState(5, ['B', 'B', 'B'])).toMatchObject({ winner: 'B', nextMapNumber: null });
  });

  it('a drawn map counts for nobody and the series can end undecided', () => {
    expect(seriesState(1, [null])).toMatchObject({ winner: null, nextMapNumber: null });
  });

  it('rounds to win per mode', () => {
    expect(roundsToWin('FIVE_V_FIVE')).toBe(13);
    expect(roundsToWin('WINGMAN')).toBe(9);
  });
});

describe('gateway schemas', () => {
  it('accepts a heartbeat and rejects nonsense', () => {
    const ok = heartbeatSchema.safeParse({ status: 'READY', currentMatchId: null, players: 0, version: '1.0.0', timestampMs: NOW });
    expect(ok.success).toBe(true);
    expect(heartbeatSchema.safeParse({ status: 'OFFLINE', currentMatchId: null, players: 0, version: '1', timestampMs: NOW }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ status: 'READY', currentMatchId: 'x', players: 0, version: '1', timestampMs: NOW }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ status: 'READY', currentMatchId: null, players: -1, version: '1', timestampMs: NOW }).success).toBe(false);
  });

  it('validates the event union by type', () => {
    const base = { seq: 1, idempotencyKey: 'evt-0000001', at: NOW, matchId: MATCH_ID };
    const ok = eventBatchSchema.safeParse({
      events: [
        { ...base, type: 'player.connected', steamId: teamA[0] },
        { ...base, idempotencyKey: 'evt-0000002', type: 'round.ended', mapNumber: 1, scoreA: 3, scoreB: 2 },
        { ...base, idempotencyKey: 'evt-0000003', type: 'match.paused', team: 'A' },
      ],
    });
    expect(ok.success).toBe(true);
    expect(eventBatchSchema.safeParse({ events: [{ ...base, type: 'player.connected', steamId: 'nope' }] }).success).toBe(false);
    expect(eventBatchSchema.safeParse({ events: [{ ...base, type: 'format.disk' }] }).success).toBe(false);
    expect(eventBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(eventBatchSchema.safeParse({ events: Array.from({ length: 101 }, () => ({ ...base, type: 'match.unpaused' })) }).success).toBe(false);
  });

  it('result payloads fill optional counters with zero and turn timestamps into dates', () => {
    const parsed = report();
    expect(parsed.players[0]!.flashAssists).toBe(0);
    expect(parsed.startedAt).toBeInstanceOf(Date);
    expect(parsed.endReason).toBe('NORMAL');
  });

  it('rejects malformed results', () => {
    expect(mapResultSchema.safeParse({ ...report(), players: [] }).success).toBe(false);
    expect(() => report({ scoreA: -1 })).toThrow();
    expect(() => report({ startedAt: 'yesterday' as never })).toThrow();
  });

  it('skin commands accept a player or "all" and bound the level', () => {
    expect(skinCommandSchema.safeParse({ actorSteamId: teamA[0], target: 'all', level: 3 }).success).toBe(true);
    expect(skinCommandSchema.safeParse({ actorSteamId: teamA[0], target: teamB[0], level: 2, durationMinutes: 120 }).success).toBe(true);
    expect(skinCommandSchema.safeParse({ actorSteamId: teamA[0], target: 'everyone', level: 3 }).success).toBe(false);
    expect(skinCommandSchema.safeParse({ actorSteamId: teamA[0], target: 'all', level: 4 }).success).toBe(false);
  });
});
