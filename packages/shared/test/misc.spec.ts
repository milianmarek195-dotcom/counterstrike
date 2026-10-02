import { describe, expect, it } from 'vitest';
import {
  ENABLED_GAME_MODES,
  MATCH_SETUP_STATUSES,
  WINGMAN_COMING_SOON,
  createTournamentSchema,
  isGameModeEnabled,
  MATCH_STATUSES,
  MATCH_TRANSITIONS,
  SERVER_STATUSES,
  SERVER_TRANSITIONS,
  SHARE_CODE_ALPHABET,
  TOURNAMENT_STATUSES,
  TOURNAMENT_TRANSITIONS,
  addCombatStats,
  assertTransition,
  averageDamagePerRound,
  canTransition,
  deriveStats,
  displayMatchStatus,
  generateShareCode,
  headshotPercentage,
  isMatchTerminal,
  isSteamId64,
  isValidShareCode,
  killDeathRatio,
  normalizeShareCode,
  sumCombatStats,
  winRate,
  InvalidTransitionError,
  EMPTY_COMBAT_STATS,
} from '../src/index.js';
import {
  SIGNATURE_HEADERS,
  canonicalString,
  deriveServerKey,
  isTimestampFresh,
  sha256Hex,
  signRequest,
  verifySignature,
} from '../src/signing.js';

describe('share codes', () => {
  it('generates well-formed codes from the safe alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateShareCode();
      expect(isValidShareCode(code)).toBe(true);
      expect(code).toMatch(/^CELTIST-[A-Z2-9]{6}$/);
      for (const ch of code.slice(8)) expect(SHARE_CODE_ALPHABET).toContain(ch);
    }
  });

  it('never uses ambiguous characters', () => {
    for (const bad of ['0', 'O', '1', 'I', 'L']) expect(SHARE_CODE_ALPHABET).not.toContain(bad);
  });

  it('is unbiased enough to produce many distinct codes', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateShareCode()));
    expect(codes.size).toBeGreaterThan(1990);
  });

  it('is deterministic with injected randomness (and rejects biased bytes)', () => {
    // bytes ≥ 248 are rejected, so 255 must be skipped.
    const bytes = [255, 0, 1, 2, 3, 4, 5, 250, 6];
    let i = 0;
    const code = generateShareCode((n) => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]!));
    expect(code).toBe('CELTIST-ABCDEF');
  });

  it('normalises user input', () => {
    expect(normalizeShareCode('celtist-x7k2p9')).toBe('CELTIST-X7K2P9');
    expect(normalizeShareCode('  X7K2P9 ')).toBe('CELTIST-X7K2P9');
    expect(normalizeShareCode('celtist x7k2p9')).toBe('CELTIST-X7K2P9');
    expect(normalizeShareCode('CELTISTX7K2P9')).toBe('CELTIST-X7K2P9');
  });

  it('rejects invalid input', () => {
    expect(normalizeShareCode('')).toBeNull();
    expect(normalizeShareCode('X7K2P')).toBeNull();
    expect(normalizeShareCode('X7K2P90')).toBeNull();
    expect(normalizeShareCode('X7K2PO')).toBeNull(); // letter O is not in the alphabet
    expect(normalizeShareCode("CELTIST-'; DROP TABLE")).toBeNull();
    expect(isValidShareCode('celtist-x7k2p9')).toBe(false);
  });
});

describe('state machines', () => {
  it('has a transition entry for every state', () => {
    for (const s of MATCH_STATUSES) expect(MATCH_TRANSITIONS[s]).toBeDefined();
    for (const s of TOURNAMENT_STATUSES) expect(TOURNAMENT_TRANSITIONS[s]).toBeDefined();
    for (const s of SERVER_STATUSES) expect(SERVER_TRANSITIONS[s]).toBeDefined();
  });

  it('only references known states', () => {
    for (const [from, tos] of Object.entries(MATCH_TRANSITIONS)) {
      for (const to of tos) expect(MATCH_STATUSES as readonly string[], `${from}→${to}`).toContain(to);
    }
  });

  it('follows the documented match lifecycle', () => {
    const path = ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'CONFIGURING', 'LIVE', 'FINISHED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(MATCH_TRANSITIONS, path[i]!, path[i + 1]!)).toBe(true);
  });

  it('forbids shortcuts and leaving terminal states', () => {
    expect(canTransition(MATCH_TRANSITIONS, 'WAITING', 'LIVE')).toBe(false);
    expect(canTransition(MATCH_TRANSITIONS, 'LIVE', 'LOBBY')).toBe(false);
    for (const to of MATCH_STATUSES) {
      expect(canTransition(MATCH_TRANSITIONS, 'FINISHED', to)).toBe(false);
      expect(canTransition(MATCH_TRANSITIONS, 'CANCELLED', to)).toBe(false);
    }
    expect(isMatchTerminal('FINISHED')).toBe(true);
    expect(isMatchTerminal('SERVER_ERROR')).toBe(false);
  });

  it('allows server error recovery paths only', () => {
    // Resume, restart, cancel, or settle by admin decision – never a rated "normal" result out of an error state.
    expect(MATCH_TRANSITIONS.SERVER_ERROR).toEqual(['LIVE', 'CONFIGURING', 'CANCELLED', 'FINISHED']);
  });

  it('has no ready phase: the lobby leads to veto, forced map or start', () => {
    expect(MATCH_STATUSES as readonly string[]).not.toContain('READY_CHECK');
    expect(MATCH_TRANSITIONS.LOBBY).toEqual(expect.arrayContaining(['VETO', 'MAP_FORCED', 'CONFIGURING']));
    expect(canTransition(MATCH_TRANSITIONS, 'LOBBY', 'LIVE')).toBe(false);
  });

  it('a forced map overrides the veto and only leaves the state through start, veto restart, reset or cancel', () => {
    expect(canTransition(MATCH_TRANSITIONS, 'VETO', 'MAP_FORCED')).toBe(true);
    expect(canTransition(MATCH_TRANSITIONS, 'MAP_FORCED', 'CONFIGURING')).toBe(true);
    expect(canTransition(MATCH_TRANSITIONS, 'MAP_FORCED', 'VETO')).toBe(true);
    expect(canTransition(MATCH_TRANSITIONS, 'MAP_FORCED', 'LIVE')).toBe(false);
    expect(canTransition(MATCH_TRANSITIONS, 'LIVE', 'MAP_FORCED')).toBe(false); // no map forcing mid-match
    expect(canTransition(MATCH_TRANSITIONS, 'CONFIGURING', 'MAP_FORCED')).toBe(false);
    expect(displayMatchStatus('MAP_FORCED')).toBe('READY');
  });

  it('setup states are exactly the ones where teams and maps may still change', () => {
    expect([...MATCH_SETUP_STATUSES].sort()).toEqual(['LOBBY', 'MAP_FORCED', 'SCHEDULED', 'VETO', 'WAITING']);
  });

  it('Wingman is a data-model placeholder only: coming soon, not enabled', () => {
    expect(ENABLED_GAME_MODES).toEqual(['FIVE_V_FIVE']);
    expect(isGameModeEnabled('WINGMAN')).toBe(false);
    expect(WINGMAN_COMING_SOON).toBe(true);
    expect(createTournamentSchema.safeParse({ name: 'Duo Cup', format: 'SINGLE_ELIMINATION', mode: 'WINGMAN', maxTeams: 4, startsAt: '2026-10-03T18:00:00Z' }).success).toBe(false);
    expect(createTournamentSchema.safeParse({ name: 'Duo Cup', format: 'SINGLE_ELIMINATION', teamSize: 2, maxTeams: 4, startsAt: '2026-10-03T18:00:00Z' }).success).toBe(true);
  });

  it('assertTransition throws a typed error', () => {
    expect(() => assertTransition('match', MATCH_TRANSITIONS, 'FINISHED', 'LIVE')).toThrow(InvalidTransitionError);
    expect(() => assertTransition('match', MATCH_TRANSITIONS, 'LIVE', 'FINISHED')).not.toThrow();
  });

  it('tournament: pause/resume and cancel rules', () => {
    expect(canTransition(TOURNAMENT_TRANSITIONS, 'RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition(TOURNAMENT_TRANSITIONS, 'PAUSED', 'RUNNING')).toBe(true);
    expect(canTransition(TOURNAMENT_TRANSITIONS, 'DRAFT', 'RUNNING')).toBe(false);
    expect(canTransition(TOURNAMENT_TRANSITIONS, 'FINISHED', 'CANCELLED')).toBe(false);
  });

  it('server: IN_USE cannot be allocated again directly', () => {
    expect(canTransition(SERVER_TRANSITIONS, 'READY', 'IN_USE')).toBe(true);
    expect(canTransition(SERVER_TRANSITIONS, 'IN_USE', 'IN_USE')).toBe(false);
    expect(canTransition(SERVER_TRANSITIONS, 'IN_USE', 'ONLINE')).toBe(false);
  });

  it('collapses detailed statuses for display', () => {
    expect(displayMatchStatus('LOBBY')).toBe('READY');
    expect(displayMatchStatus('VETO')).toBe('READY');
    expect(displayMatchStatus('CONFIGURING')).toBe('READY');
    expect(displayMatchStatus('SERVER_ERROR')).toBe('LIVE');
    expect(displayMatchStatus('FINISHED')).toBe('FINISHED');
  });
});

describe('derived stats', () => {
  it('never divides by zero', () => {
    expect(killDeathRatio(10, 0)).toBe(10);
    expect(killDeathRatio(0, 0)).toBe(0);
    expect(averageDamagePerRound(100, 0)).toBe(0);
    expect(headshotPercentage(3, 0)).toBe(0);
    expect(winRate(0, 0)).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(killDeathRatio(20, 14)).toBe(1.43);
    expect(averageDamagePerRound(2250, 30)).toBe(75);
    expect(headshotPercentage(9, 20)).toBe(45);
    expect(winRate(2, 3)).toBe(66.67);
  });

  it('sums and derives', () => {
    const a = { ...EMPTY_COMBAT_STATS, kills: 10, deaths: 5, damage: 1500, rounds: 20, headshots: 4 };
    const b = { ...EMPTY_COMBAT_STATS, kills: 20, deaths: 15, damage: 1800, rounds: 22, headshots: 8 };
    expect(addCombatStats(a, b).kills).toBe(30);
    const total = sumCombatStats([a, b]);
    expect(deriveStats(total)).toEqual({ kd: 1.5, adr: 78.57, hsPercent: 40 });
    expect(sumCombatStats([])).toEqual(EMPTY_COMBAT_STATS);
  });
});

describe('steam ids', () => {
  it('accepts SteamID64 of individual accounts only', () => {
    expect(isSteamId64('76561198000000000')).toBe(true);
    expect(isSteamId64('7656119800000000')).toBe(false);
    expect(isSteamId64('76561198000000000a')).toBe(false);
    expect(isSteamId64('12345678901234567')).toBe(false);
  });
});

describe('request signing', () => {
  const master = 'm'.repeat(48);
  const input = { method: 'post', pathWithQuery: '/server/v1/events', timestampMs: 1_700_000_000_000, nonce: 'abc123', body: '{"a":1}' };

  it('derives distinct, stable keys per server and key version', () => {
    const k1 = deriveServerKey(master, 'server-1', 1);
    expect(deriveServerKey(master, 'server-1', 1).equals(k1)).toBe(true);
    expect(deriveServerKey(master, 'server-2', 1).equals(k1)).toBe(false);
    expect(deriveServerKey(master, 'server-1', 2).equals(k1)).toBe(false);
    expect(deriveServerKey('x'.repeat(48), 'server-1', 1).equals(k1)).toBe(false);
    expect(k1).toHaveLength(32);
    expect(() => deriveServerKey(master, 's', 0)).toThrow();
  });

  it('builds the documented canonical string', () => {
    expect(canonicalString(input)).toBe(['POST', '/server/v1/events', '1700000000000', 'abc123', sha256Hex('{"a":1}')].join('\n'));
  });

  it('verifies a valid signature', () => {
    const key = deriveServerKey(master, 's', 1);
    const sig = signRequest(key, input);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature(key, input, sig)).toBe(true);
  });

  it('rejects tampering with any part of the request', () => {
    const key = deriveServerKey(master, 's', 1);
    const sig = signRequest(key, input);
    expect(verifySignature(key, { ...input, body: '{"a":2}' }, sig)).toBe(false);
    expect(verifySignature(key, { ...input, pathWithQuery: '/server/v1/other' }, sig)).toBe(false);
    expect(verifySignature(key, { ...input, method: 'GET' }, sig)).toBe(false);
    expect(verifySignature(key, { ...input, nonce: 'zzz' }, sig)).toBe(false);
    expect(verifySignature(key, { ...input, timestampMs: input.timestampMs + 1 }, sig)).toBe(false);
    expect(verifySignature(deriveServerKey(master, 's', 2), input, sig)).toBe(false);
  });

  it('rejects malformed signatures without throwing', () => {
    const key = deriveServerKey(master, 's', 1);
    expect(verifySignature(key, input, '')).toBe(false);
    expect(verifySignature(key, input, 'zz'.repeat(32))).toBe(false);
    expect(verifySignature(key, input, 'ab')).toBe(false);
  });

  it('checks timestamp freshness in both directions', () => {
    expect(isTimestampFresh(1000, 1000, 30_000)).toBe(true);
    expect(isTimestampFresh(1000, 31_000, 30_000)).toBe(true);
    expect(isTimestampFresh(1000, 31_001, 30_000)).toBe(false);
    expect(isTimestampFresh(31_001, 1000, 30_000)).toBe(false);
    expect(isTimestampFresh(Number.NaN, 1000, 30_000)).toBe(false);
    expect(SIGNATURE_HEADERS.signature).toBe('x-celtist-signature');
  });
});
