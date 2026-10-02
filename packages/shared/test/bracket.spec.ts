import { describe, expect, it } from 'vitest';
import {
  BracketError,
  applyResult,
  computePlacements,
  createInitialState,
  doubleEliminationGenerator,
  getBracketGenerator,
  seedOrder,
  singleEliminationGenerator,
  stateFromSnapshot,
  type BracketParticipant,
  type BracketState,
  type GeneratedBracket,
  type Slot,
} from '../src/index.js';

const participants = (n: number): BracketParticipant[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, seed: i + 1 }));

/** Small deterministic PRNG so "random" tournaments are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Simulation {
  state: BracketState;
  champion: string | null;
  played: string[];
  autoResolved: string[];
}

/** Plays a bracket to the end; `pickWinner` decides each game from the two participant ids and the node key. */
function simulate(
  bracket: GeneratedBracket,
  pickWinner: (nodeKey: string, a: string, b: string) => Slot,
): Simulation {
  const initial = createInitialState(bracket);
  let state = initial.state;
  let champion = initial.events.champion;
  const ready = new Set(initial.events.ready);
  const autoResolved = initial.events.autoResolved.map((e) => e.nodeKey);
  const played: string[] = [];

  let guard = 0;
  while (ready.size > 0) {
    if (++guard > 1000) throw new Error('simulation does not terminate');
    // Deterministic order: the lexicographically smallest ready key.
    const key = [...ready].sort()[0]!;
    ready.delete(key);
    const st = state.get(key)!;
    const slot = pickWinner(key, st.teamA!, st.teamB!);
    const result = applyResult(bracket, state, key, slot);
    state = result.state;
    played.push(key);
    for (const k of result.events.ready) ready.add(k);
    for (const e of result.events.autoResolved) autoResolved.push(e.nodeKey);
    if (result.events.champion) champion = result.events.champion;
  }
  return { state, champion, played, autoResolved };
}

const higherSeedWins = (_: string, a: string, b: string): Slot => {
  const rank = (id: string): number => Number(id.slice(1));
  return rank(a) < rank(b) ? 'A' : 'B';
};

describe('seedOrder', () => {
  it('keeps the top seeds apart', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(seedOrder(16).slice(0, 4)).toEqual([1, 16, 8, 9]);
  });

  it('rejects sizes that are not a power of two', () => {
    expect(() => seedOrder(6)).toThrow();
    expect(() => seedOrder(1)).toThrow();
  });
});

describe('single elimination', () => {
  it('builds the classic 8-team bracket', () => {
    const bracket = singleEliminationGenerator.generate(participants(8));
    expect(bracket.size).toBe(8);
    expect(bracket.nodes).toHaveLength(7);
    const round1 = bracket.nodes.filter((n) => n.round === 1);
    const pairs = round1.map((n) =>
      n.sources.map((s) => (s.type === 'PARTICIPANT' ? s.participantId : '?')).join('-'),
    );
    expect(pairs).toEqual(['p1-p8', 'p4-p5', 'p2-p7', 'p3-p6']);
    expect(bracket.nodes.map((n) => n.label)).toEqual([
      'Quarterfinal', 'Quarterfinal', 'Quarterfinal', 'Quarterfinal', 'Semifinal', 'Semifinal', 'Final',
    ]);
    expect(bracket.finalKey).toBe('U3-0');
    expect(bracket.resetKey).toBeNull();
  });

  it('gives the top seeds byes when the field is not a power of two', () => {
    const bracket = singleEliminationGenerator.generate(participants(6));
    expect(bracket.size).toBe(8);
    const byes = bracket.nodes.filter((n) => n.isBye).map((n) => n.key);
    expect(byes).toHaveLength(2);
    const initial = createInitialState(bracket);
    // Seeds 1 and 2 advance without playing.
    expect(initial.events.autoResolved.map((e) => e.winnerId).sort()).toEqual(['p1', 'p2']);
  });

  it('plays a third-place match when asked', () => {
    const bracket = singleEliminationGenerator.generate(participants(8), { thirdPlaceMatch: true });
    expect(bracket.nodes.find((n) => n.key === 'T-1')).toBeDefined();
    const sim = simulate(bracket, higherSeedWins);
    expect(sim.played).toContain('T-1');
    const placements = computePlacements(bracket, sim.state);
    expect(placements.get('p1')).toBe(1);
    expect(placements.get('p2')).toBe(2);
    expect(placements.get('p3')).toBe(3);
    expect(placements.get('p4')).toBe(4);
  });

  it.each(Array.from({ length: 39 }, (_, i) => i + 2))('plays a complete bracket with %i participants', (n) => {
    const bracket = singleEliminationGenerator.generate(participants(n));
    const sim = simulate(bracket, higherSeedWins);
    expect(sim.champion).toBe('p1');
    expect(sim.played).toHaveLength(n - 1);
    for (const st of sim.state.values()) expect(st.done || st.cancelled).toBe(true);
    const placements = computePlacements(bracket, sim.state);
    expect(placements.get('p1')).toBe(1);
    expect(placements.get('p2')).toBe(2);
  });

  it('handles upsets: any seed can win', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = mulberry32(seed);
      const n = 2 + Math.floor(rand() * 30);
      const bracket = singleEliminationGenerator.generate(participants(n));
      const sim = simulate(bracket, () => (rand() < 0.5 ? 'A' : 'B'));
      expect(sim.champion).not.toBeNull();
      expect(sim.played).toHaveLength(n - 1);
    }
  });
});

describe('double elimination', () => {
  it('has the expected node counts for 8 teams', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8));
    expect(bracket.nodes.filter((n) => n.side === 'UPPER')).toHaveLength(7);
    expect(bracket.nodes.filter((n) => n.side === 'LOWER')).toHaveLength(6);
    expect(bracket.nodes.filter((n) => n.side === 'GRAND_FINAL')).toHaveLength(2);
    expect(bracket.finalKey).toBe('GF-1');
    expect(bracket.resetKey).toBe('GF-2');
  });

  it('omits the reset node when disabled', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8), { grandFinalReset: false });
    expect(bracket.resetKey).toBeNull();
    expect(bracket.nodes.some((n) => n.key === 'GF-2')).toBe(false);
  });

  it('drops upper-bracket losers into the lower bracket', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8));
    for (const node of bracket.nodes.filter((n) => n.side === 'UPPER')) {
      expect(node.loserNext, node.key).not.toBeNull();
      expect(node.loserNext!.nodeKey.startsWith('L')).toBe(true);
    }
    for (const node of bracket.nodes.filter((n) => n.side === 'LOWER')) {
      expect(node.loserNext, node.key).toBeNull();
    }
  });

  it('keeps links consistent with slot sources', () => {
    for (const n of [3, 4, 5, 7, 8, 9, 16, 17, 31]) {
      const bracket = doubleEliminationGenerator.generate(participants(n));
      const byKey = new Map(bracket.nodes.map((node) => [node.key, node] as const));
      for (const node of bracket.nodes) {
        if (node.winnerNext) {
          const target = byKey.get(node.winnerNext.nodeKey)!;
          const source = target.sources[node.winnerNext.slot === 'A' ? 0 : 1];
          expect(source).toEqual({ type: 'WINNER_OF', nodeKey: node.key });
        }
        if (node.loserNext) {
          const target = byKey.get(node.loserNext.nodeKey)!;
          const source = target.sources[node.loserNext.slot === 'A' ? 0 : 1];
          expect(source).toEqual({ type: 'LOSER_OF', nodeKey: node.key });
        }
      }
    }
  });

  it.each(Array.from({ length: 39 }, (_, i) => i + 2))(
    'plays a complete bracket with %i participants (favourite wins)',
    (n) => {
      const bracket = doubleEliminationGenerator.generate(participants(n));
      const sim = simulate(bracket, higherSeedWins);
      expect(sim.champion).toBe('p1');
      // Everyone but the champion loses exactly twice; with a favourite winning the grand final no reset is played.
      // (With only two teams a double elimination degenerates to a single final.)
      expect(sim.played).toHaveLength(n === 2 ? 1 : 2 * n - 2);
      for (const st of sim.state.values()) expect(st.done || st.cancelled).toBe(true);
      const placements = computePlacements(bracket, sim.state);
      expect(placements.get('p1')).toBe(1);
      expect(placements.get('p2')).toBe(2);
    },
  );

  it('plays the grand-final reset when the lower-bracket champion wins the first final', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8));
    const sim = simulate(bracket, (key, a, b) => {
      if (key === 'GF-1') return 'B'; // lower-bracket finalist (slot B) wins
      return higherSeedWins(key, a, b);
    });
    expect(sim.played).toContain('GF-1');
    expect(sim.played).toContain('GF-2');
    expect(sim.played).toHaveLength(2 * 8 - 1);
    expect(sim.champion).not.toBeNull();
    const gf = sim.state.get('GF-1')!;
    expect(sim.champion).toBe(sim.state.get('GF-2')!.winner);
    expect([gf.teamA, gf.teamB]).toContain(sim.champion);
  });

  it('cancels the reset when the upper-bracket champion wins', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8));
    const sim = simulate(bracket, higherSeedWins);
    expect(sim.state.get('GF-2')!.cancelled).toBe(true);
    expect(sim.played).not.toContain('GF-2');
  });

  it('terminates correctly for random results', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = mulberry32(seed * 7919);
      const n = 2 + Math.floor(rand() * 38);
      const bracket = doubleEliminationGenerator.generate(participants(n));
      const sim = simulate(bracket, () => (rand() < 0.5 ? 'A' : 'B'));
      expect(sim.champion, `n=${n} seed=${seed}`).not.toBeNull();
      const games = sim.played.length;
      expect(n === 2 ? [1] : [2 * n - 2, 2 * n - 1]).toContain(games);
      for (const st of sim.state.values()) expect(st.done || st.cancelled).toBe(true);
      // The champion is the only participant without two losses (or with exactly one if they came through the reset).
      expect(computePlacements(bracket, sim.state).get(sim.champion!)).toBe(1);
    }
  });

  it('resolves lower-bracket byes when an upper-bracket loser arrives (5 teams)', () => {
    const bracket = doubleEliminationGenerator.generate(participants(5));
    const sim = simulate(bracket, higherSeedWins);
    expect(sim.autoResolved.some((k) => k.startsWith('L'))).toBe(true);
    expect(sim.champion).toBe('p1');
  });

  it('assigns shared placements for eliminated players (8 teams)', () => {
    const bracket = doubleEliminationGenerator.generate(participants(8));
    const sim = simulate(bracket, higherSeedWins);
    const placements = computePlacements(bracket, sim.state);
    const values = [...placements.values()].sort((a, b) => a - b);
    expect(values).toEqual([1, 2, 3, 4, 5, 5, 7, 7]);
  });
});

describe('progression engine', () => {
  const bracket = singleEliminationGenerator.generate(participants(4));

  it('refuses results for nodes that are not ready', () => {
    const { state } = createInitialState(bracket);
    expect(() => applyResult(bracket, state, 'U2-0', 'A')).toThrow(BracketError);
  });

  it('refuses a second result for the same node', () => {
    const { state } = createInitialState(bracket);
    const first = applyResult(bracket, state, 'U1-0', 'A');
    expect(() => applyResult(bracket, first.state, 'U1-0', 'B')).toThrow(/already has a result/);
  });

  it('does not mutate the input state', () => {
    const { state } = createInitialState(bracket);
    const before = JSON.stringify([...state]);
    applyResult(bracket, state, 'U1-0', 'A');
    expect(JSON.stringify([...state])).toBe(before);
  });

  it('can continue from a persisted snapshot', () => {
    const { state } = createInitialState(bracket);
    const afterFirst = applyResult(bracket, state, 'U1-0', 'A').state;
    const snapshot = [...afterFirst].map(([key, st]) => ({
      key,
      teamA: st.teamA,
      teamB: st.teamB,
      winner: st.winner,
      done: st.done,
    }));
    const restored = stateFromSnapshot(bracket, snapshot);
    const second = applyResult(bracket, restored, 'U1-1', 'B');
    expect(second.events.ready).toEqual(['U2-0']);
    expect(restored.get('U1-0')!.loser).toBe('p4');
  });

  it('rejects unknown formats', () => {
    expect(() => getBracketGenerator('SWISS')).toThrow(/not implemented/);
  });

  it('rejects invalid fields', () => {
    expect(() => singleEliminationGenerator.generate(participants(1))).toThrow(/at least 2/);
    expect(() =>
      singleEliminationGenerator.generate([
        { id: 'a', seed: 1 },
        { id: 'a', seed: 2 },
      ]),
    ).toThrow(/Duplicate/);
  });

  it('ranks by seed even when seeds have gaps', () => {
    const gappy = singleEliminationGenerator.generate([
      { id: 'x', seed: 10 },
      { id: 'y', seed: 40 },
      { id: 'z', seed: 99 },
      { id: 'w', seed: 5 },
    ]);
    expect(gappy.size).toBe(4);
    expect(gappy.nodes.every((n) => !n.isBye)).toBe(true);
  });
});
