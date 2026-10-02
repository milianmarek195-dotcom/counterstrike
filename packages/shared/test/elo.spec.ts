import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELO_CONFIG,
  calculateMatchElo,
  expectedScore,
  kFactorFor,
  teamElo,
  type EloPlayerInput,
} from '../src/index.js';

const team = (prefix: string, elos: number[], matchesPlayed = 50): EloPlayerInput[] =>
  elos.map((elo, i) => ({ userId: `${prefix}${i}`, elo, matchesPlayed }));

describe('expectedScore', () => {
  it('is 0.5 for equal ratings', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('is symmetric: E(a,b) + E(b,a) = 1', () => {
    for (const [a, b] of [[1000, 1200], [900, 1500], [2000, 800]] as const) {
      expect(expectedScore(a, b) + expectedScore(b, a)).toBeCloseTo(1, 10);
    }
  });

  it('gives ~0.76 for a 200 point advantage', () => {
    expect(expectedScore(1200, 1000)).toBeCloseTo(0.7597, 3);
  });
});

describe('teamElo', () => {
  it('averages the players', () => {
    expect(teamElo([{ elo: 1000 }, { elo: 1200 }, { elo: 1100 }])).toBe(1100);
  });

  it('rejects empty teams', () => {
    expect(() => teamElo([])).toThrow(RangeError);
  });
});

describe('kFactorFor', () => {
  it('uses the placement factor for new players, the high factor at the top', () => {
    expect(kFactorFor({ elo: 1000, matchesPlayed: 0 }, DEFAULT_ELO_CONFIG)).toBe(40);
    expect(kFactorFor({ elo: 1000, matchesPlayed: 10 }, DEFAULT_ELO_CONFIG)).toBe(28);
    expect(kFactorFor({ elo: 1800, matchesPlayed: 80 }, DEFAULT_ELO_CONFIG)).toBe(20);
    expect(kFactorFor({ elo: 1900, matchesPlayed: 3 }, DEFAULT_ELO_CONFIG)).toBe(40);
  });
});

describe('calculateMatchElo', () => {
  it('moves evenly matched veterans by K/2', () => {
    const result = calculateMatchElo(team('a', [1000, 1000]), team('b', [1000, 1000]), 'WIN');
    expect(result.teamA.map((r) => r.delta)).toEqual([14, 14]);
    expect(result.teamB.map((r) => r.delta)).toEqual([-14, -14]);
  });

  it('rewards upsets more than expected wins', () => {
    const underdogWins = calculateMatchElo(team('a', [900]), team('b', [1300]), 'WIN');
    const favouriteWins = calculateMatchElo(team('a', [1300]), team('b', [900]), 'WIN');
    expect(underdogWins.teamA[0]!.delta).toBeGreaterThan(favouriteWins.teamA[0]!.delta);
    expect(underdogWins.teamA[0]!.delta).toBeGreaterThan(20);
    expect(favouriteWins.teamA[0]!.delta).toBeLessThan(8);
  });

  it('is based on team averages, not individual ratings', () => {
    const result = calculateMatchElo(team('a', [800, 1200]), team('b', [1000, 1000]), 'LOSS');
    // Equal team averages: loser drops by K/2 regardless of own rating.
    expect(result.teamA.map((r) => r.delta)).toEqual([-14, -14]);
    expect(result.teamAElo).toBe(1000);
    expect(result.teamBElo).toBe(1000);
  });

  it('handles draws symmetrically around the expectation', () => {
    const result = calculateMatchElo(team('a', [1200]), team('b', [1000]), 'DRAW');
    expect(result.teamA[0]!.delta).toBeLessThan(0);
    expect(result.teamB[0]!.delta).toBeGreaterThan(0);
    expect(result.teamA[0]!.outcome).toBe('DRAW');
  });

  it('always moves a decisive result by at least one point', () => {
    const result = calculateMatchElo(team('a', [2500]), team('b', [500]), 'WIN');
    expect(result.teamA[0]!.delta).toBeGreaterThanOrEqual(1);
    expect(result.teamB[0]!.delta).toBeLessThanOrEqual(-1);
  });

  it('never drops below the floor and reports the real change', () => {
    const result = calculateMatchElo(team('a', [100], 50), team('b', [1000], 50), 'LOSS');
    expect(result.teamA[0]!.eloAfter).toBe(DEFAULT_ELO_CONFIG.floor);
    expect(result.teamA[0]!.delta).toBe(0);
  });

  it('applies the placement factor per player', () => {
    const result = calculateMatchElo(
      [
        { userId: 'new', elo: 1000, matchesPlayed: 0 },
        { userId: 'old', elo: 1000, matchesPlayed: 100 },
      ],
      team('b', [1000, 1000]),
      'WIN',
    );
    const [rookie, veteran] = result.teamA;
    expect(rookie!.kFactor).toBe(40);
    expect(veteran!.kFactor).toBe(28);
    expect(rookie!.delta).toBeGreaterThan(veteran!.delta);
  });

  it('is deterministic: the same input always yields the same output', () => {
    const run = () => calculateMatchElo(team('a', [1010, 990, 1100]), team('b', [1050, 1020, 980]), 'WIN');
    expect(run()).toEqual(run());
  });

  it('is zero-sum for equal K and unclamped ratings', () => {
    const result = calculateMatchElo(team('a', [1100, 1000]), team('b', [1050, 1050]), 'WIN');
    const total = [...result.teamA, ...result.teamB].reduce((s, r) => s + r.delta, 0);
    expect(Math.abs(total)).toBeLessThanOrEqual(2); // rounding only
  });
});
