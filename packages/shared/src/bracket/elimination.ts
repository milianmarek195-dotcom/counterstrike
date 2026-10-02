import type { TournamentFormat } from '../constants.js';
import {
  BracketError,
  DEFAULT_BRACKET_OPTIONS,
  type BracketGenerator,
  type BracketNode,
  type BracketOptions,
  type BracketParticipant,
  type GeneratedBracket,
  type Slot,
  type SlotSource,
} from './types.js';

export const MAX_BRACKET_PARTICIPANTS = 256;

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Bracket positions for seeds 1..size so that the best seeds can only meet late:
 * size 8 → [1,8,4,5,2,7,3,6] (pairs 1-8, 4-5, 2-7, 3-6).
 */
export function seedOrder(size: number): number[] {
  if (size < 2 || (size & (size - 1)) !== 0) throw new RangeError('size must be a power of two ≥ 2');
  let order = [1];
  while (order.length < size) {
    const m = order.length * 2;
    order = order.flatMap((seed) => [seed, m + 1 - seed]);
  }
  return order;
}

interface RawNode {
  key: string;
  side: BracketNode['side'];
  round: number;
  position: number;
  label: string;
  sources: [SlotSource, SlotSource];
}

const winnerOf = (nodeKey: string): SlotSource => ({ type: 'WINNER_OF', nodeKey });
const loserOf = (nodeKey: string): SlotSource => ({ type: 'LOSER_OF', nodeKey });
const EMPTY: SlotSource = { type: 'EMPTY' };

function upperLabel(format: TournamentFormat, round: number, rounds: number): string {
  const fromEnd = rounds - round;
  if (format === 'SINGLE_ELIMINATION') {
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinal';
    if (fromEnd === 2) return 'Quarterfinal';
    return `Round of ${2 ** (fromEnd + 1)}`;
  }
  if (rounds === 1) return 'Final';
  if (fromEnd === 0) return 'Upper Final';
  if (fromEnd === 1) return 'Upper Semifinal';
  return `Upper Round ${round}`;
}

function normaliseParticipants(participants: readonly BracketParticipant[]): BracketParticipant[] {
  if (participants.length < 2) throw new BracketError('A bracket needs at least 2 participants');
  if (participants.length > MAX_BRACKET_PARTICIPANTS) {
    throw new BracketError(`A bracket supports at most ${MAX_BRACKET_PARTICIPANTS} participants`);
  }
  const ids = new Set<string>();
  for (const p of participants) {
    if (ids.has(p.id)) throw new BracketError(`Duplicate participant ${p.id}`);
    ids.add(p.id);
    if (!Number.isFinite(p.seed)) throw new BracketError(`Invalid seed for ${p.id}`);
  }
  // Rank by seed (ties broken by id for determinism) and renumber 1..N so gaps never create phantom byes.
  return [...participants]
    .sort((a, b) => a.seed - b.seed || (a.id < b.id ? -1 : 1))
    .map((p, index) => ({ id: p.id, seed: index + 1 }));
}

function buildRawNodes(
  format: TournamentFormat,
  seeded: readonly BracketParticipant[],
  size: number,
  options: BracketOptions,
): { nodes: Map<string, RawNode>; finalKey: string; resetKey: string | null } {
  const rounds = Math.log2(size);
  const bySeed = new Map(seeded.map((p) => [p.seed, p.id] as const));
  const nodes = new Map<string, RawNode>();
  const add = (node: RawNode): void => {
    nodes.set(node.key, node);
  };

  // Upper bracket (the whole bracket for single elimination).
  const order = seedOrder(size);
  const seedSource = (seed: number): SlotSource => {
    const id = bySeed.get(seed);
    return id === undefined ? EMPTY : { type: 'PARTICIPANT', participantId: id };
  };
  for (let round = 1; round <= rounds; round++) {
    const matches = size / 2 ** round;
    for (let i = 0; i < matches; i++) {
      const sources: [SlotSource, SlotSource] =
        round === 1
          ? [seedSource(order[2 * i]!), seedSource(order[2 * i + 1]!)]
          : [winnerOf(`U${round - 1}-${2 * i}`), winnerOf(`U${round - 1}-${2 * i + 1}`)];
      add({ key: `U${round}-${i}`, side: 'UPPER', round, position: i, label: upperLabel(format, round, rounds), sources });
    }
  }
  const upperFinal = `U${rounds}-0`;

  if (format === 'SINGLE_ELIMINATION') {
    if (options.thirdPlaceMatch && size >= 4) {
      const semi = `U${rounds - 1}`;
      add({
        key: 'T-1',
        side: 'LOWER',
        round: 1,
        position: 0,
        label: 'Third Place',
        sources: [loserOf(`${semi}-0`), loserOf(`${semi}-1`)],
      });
    }
    return { nodes, finalKey: upperFinal, resetKey: null };
  }

  // Double elimination.
  if (rounds === 1) return { nodes, finalKey: upperFinal, resetKey: null };

  const lowerRounds = 2 * (rounds - 1);
  for (let j = 1; j <= rounds - 1; j++) {
    const count = size / 2 ** (j + 1);
    const consolidation = 2 * j - 1;
    const dropIn = 2 * j;
    for (let i = 0; i < count; i++) {
      const sources: [SlotSource, SlotSource] =
        j === 1
          ? [loserOf(`U1-${2 * i}`), loserOf(`U1-${2 * i + 1}`)]
          : [winnerOf(`L${2 * j - 2}-${2 * i}`), winnerOf(`L${2 * j - 2}-${2 * i + 1}`)];
      add({
        key: `L${consolidation}-${i}`,
        side: 'LOWER',
        round: consolidation,
        position: i,
        label: consolidation === lowerRounds ? 'Lower Final' : `Lower Round ${consolidation}`,
        sources,
      });
    }
    for (let i = 0; i < count; i++) {
      // Alternate the drop-in order so losers meet opponents from the other half (avoids instant rematches).
      const upperIndex = j % 2 === 1 ? count - 1 - i : i;
      add({
        key: `L${dropIn}-${i}`,
        side: 'LOWER',
        round: dropIn,
        position: i,
        label: dropIn === lowerRounds ? 'Lower Final' : `Lower Round ${dropIn}`,
        sources: [winnerOf(`L${consolidation}-${i}`), loserOf(`U${j + 1}-${upperIndex}`)],
      });
    }
  }

  add({
    key: 'GF-1',
    side: 'GRAND_FINAL',
    round: 1,
    position: 0,
    label: 'Grand Final',
    sources: [winnerOf(upperFinal), winnerOf(`L${lowerRounds}-0`)],
  });
  let resetKey: string | null = null;
  if (options.grandFinalReset) {
    resetKey = 'GF-2';
    add({
      key: resetKey,
      side: 'GRAND_FINAL',
      round: 2,
      position: 0,
      label: 'Grand Final Reset',
      sources: [
        { type: 'CARRY', nodeKey: 'GF-1', slot: 'A' },
        { type: 'CARRY', nodeKey: 'GF-1', slot: 'B' },
      ],
    });
  }
  return { nodes, finalKey: 'GF-1', resetKey };
}

/**
 * Static "can this ever be filled" analysis. A winner never exists if both slots are empty; a loser never
 * exists if at least one slot is empty (a bye has no loser).
 */
function analyseEmptiness(nodes: ReadonlyMap<string, RawNode>) {
  const memo = new Map<string, [boolean, boolean]>();

  const sourceEmpty = (source: SlotSource): boolean => {
    switch (source.type) {
      case 'EMPTY':
        return true;
      case 'PARTICIPANT':
        return false;
      case 'WINNER_OF':
        return winnerNever(source.nodeKey);
      case 'LOSER_OF':
        return loserNever(source.nodeKey);
      case 'CARRY':
        return sourceEmpty(requireNode(source.nodeKey).sources[source.slot === 'A' ? 0 : 1]);
    }
  };
  const requireNode = (key: string): RawNode => {
    const node = nodes.get(key);
    if (!node) throw new BracketError(`Unknown bracket node ${key}`);
    return node;
  };
  const slotsEmpty = (key: string): [boolean, boolean] => {
    const cached = memo.get(key);
    if (cached) return cached;
    const node = requireNode(key);
    const result: [boolean, boolean] = [sourceEmpty(node.sources[0]), sourceEmpty(node.sources[1])];
    memo.set(key, result);
    return result;
  };
  const winnerNever = (key: string): boolean => {
    const [a, b] = slotsEmpty(key);
    return a && b;
  };
  const loserNever = (key: string): boolean => {
    const [a, b] = slotsEmpty(key);
    return a || b;
  };
  return { sourceEmpty, slotsEmpty, winnerNever, loserNever };
}

function finalise(
  format: TournamentFormat,
  participantCount: number,
  size: number,
  raw: Map<string, RawNode>,
  finalKey: string,
  resetKey: string | null,
): GeneratedBracket {
  const { sourceEmpty, slotsEmpty, winnerNever } = analyseEmptiness(raw);

  // Drop void nodes (neither slot can ever be filled) and rewrite sources that can never deliver.
  const kept: BracketNode[] = [];
  for (const node of raw.values()) {
    if (winnerNever(node.key)) continue;
    const [emptyA, emptyB] = slotsEmpty(node.key);
    const rewrite = (source: SlotSource): SlotSource => (sourceEmpty(source) ? EMPTY : source);
    kept.push({
      key: node.key,
      side: node.side,
      round: node.round,
      position: node.position,
      label: node.label,
      sources: [rewrite(node.sources[0]), rewrite(node.sources[1])],
      isBye: emptyA !== emptyB,
      winnerNext: null,
      loserNext: null,
    });
  }

  const byKey = new Map(kept.map((n) => [n.key, n] as const));
  for (const node of kept) {
    node.sources.forEach((source, index) => {
      const slot: Slot = index === 0 ? 'A' : 'B';
      if (source.type === 'WINNER_OF') byKey.get(source.nodeKey)!.winnerNext = { nodeKey: node.key, slot };
      if (source.type === 'LOSER_OF') byKey.get(source.nodeKey)!.loserNext = { nodeKey: node.key, slot };
    });
  }

  if (!byKey.has(finalKey)) throw new BracketError('Bracket has no final');
  return {
    format,
    participantCount,
    size,
    nodes: kept,
    finalKey,
    resetKey: resetKey !== null && byKey.has(resetKey) ? resetKey : null,
  };
}

function createGenerator(format: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION'): BracketGenerator {
  return {
    format,
    generate(participants, partial = {}) {
      const options: BracketOptions = { ...DEFAULT_BRACKET_OPTIONS, ...partial };
      const seeded = normaliseParticipants(participants);
      const size = nextPowerOfTwo(seeded.length);
      const { nodes, finalKey, resetKey } = buildRawNodes(format, seeded, size, options);
      return finalise(format, seeded.length, size, nodes, finalKey, resetKey);
    },
  };
}

export const singleEliminationGenerator = createGenerator('SINGLE_ELIMINATION');
export const doubleEliminationGenerator = createGenerator('DOUBLE_ELIMINATION');
