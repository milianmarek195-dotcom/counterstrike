import { BracketError, type BracketNode, type GeneratedBracket, type Slot } from './types.js';

/**
 * Pure bracket progression. The tournament service loads the node rows into a `BracketState`, calls
 * `applyResult`, and persists the returned events inside the same transaction as the match finalisation.
 */
export interface NodeState {
  teamA: string | null;
  teamB: string | null;
  winner: string | null;
  loser: string | null;
  /** Decided: played to a result or resolved as a bye. */
  done: boolean;
  /** Will never be played (e.g. grand-final reset that was not needed). */
  cancelled: boolean;
}

export type BracketState = Map<string, NodeState>;

export interface Placement {
  nodeKey: string;
  slot: Slot;
  participantId: string;
}

export interface AutoResolved {
  nodeKey: string;
  winnerId: string;
  loserId: string | null;
}

export interface ProgressionEvents {
  placements: Placement[];
  autoResolved: AutoResolved[];
  /** Nodes that now hold both participants and need a match. */
  ready: string[];
  cancelled: string[];
  champion: string | null;
}

const emptyEvents = (): ProgressionEvents => ({
  placements: [],
  autoResolved: [],
  ready: [],
  cancelled: [],
  champion: null,
});

const emptyNode = (): NodeState => ({ teamA: null, teamB: null, winner: null, loser: null, done: false, cancelled: false });

const SIDE_ORDER: Record<BracketNode['side'], number> = { UPPER: 0, LOWER: 1, GRAND_FINAL: 2, GROUP: 3 };

function orderedNodes(bracket: GeneratedBracket): BracketNode[] {
  return [...bracket.nodes].sort(
    (a, b) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.round - b.round || a.position - b.position,
  );
}

class Progression {
  readonly byKey: Map<string, BracketNode>;
  readonly events = emptyEvents();

  constructor(
    readonly bracket: GeneratedBracket,
    readonly state: BracketState,
  ) {
    this.byKey = new Map(bracket.nodes.map((n) => [n.key, n] as const));
  }

  node(key: string): BracketNode {
    const node = this.byKey.get(key);
    if (!node) throw new BracketError(`Unknown bracket node ${key}`);
    return node;
  }

  st(key: string): NodeState {
    const state = this.state.get(key);
    if (!state) throw new BracketError(`No state for bracket node ${key}`);
    return state;
  }

  place(nodeKey: string, slot: Slot, participantId: string): void {
    const node = this.node(nodeKey);
    const st = this.st(nodeKey);
    const field = slot === 'A' ? 'teamA' : 'teamB';
    if (st[field] === participantId) return;
    if (st[field] !== null) throw new BracketError(`Slot ${slot} of ${nodeKey} is already taken`);
    st[field] = participantId;
    this.events.placements.push({ nodeKey, slot, participantId });
    if (node.isBye) {
      this.resolveBye(node, participantId);
    } else if (st.teamA !== null && st.teamB !== null) {
      this.events.ready.push(nodeKey);
    }
  }

  /** A bye has exactly one reachable slot: its sole participant advances without a game. */
  resolveBye(node: BracketNode, participantId: string): void {
    const st = this.st(node.key);
    if (st.done) return;
    st.winner = participantId;
    st.loser = null;
    st.done = true;
    this.events.autoResolved.push({ nodeKey: node.key, winnerId: participantId, loserId: null });
    this.route(node, participantId, null, null);
  }

  route(node: BracketNode, winnerId: string, loserId: string | null, winnerSlot: Slot | null): void {
    const { finalKey, resetKey } = this.bracket;
    if (node.key === finalKey) {
      if (resetKey === null) {
        this.events.champion = winnerId;
      } else if (winnerSlot === 'A') {
        // Upper-bracket champion won the first grand final: no reset needed.
        this.events.champion = winnerId;
        this.st(resetKey).cancelled = true;
        this.events.cancelled.push(resetKey);
      } else {
        const gf = this.st(node.key);
        this.place(resetKey, 'A', gf.teamA!);
        this.place(resetKey, 'B', gf.teamB!);
      }
      return;
    }
    if (node.key === resetKey) {
      this.events.champion = winnerId;
      return;
    }
    if (node.winnerNext) this.place(node.winnerNext.nodeKey, node.winnerNext.slot, winnerId);
    if (node.loserNext && loserId !== null) this.place(node.loserNext.nodeKey, node.loserNext.slot, loserId);
  }
}

/** Empty state for every node plus the first-round placements; byes with a known participant resolve at once. */
export function createInitialState(bracket: GeneratedBracket): { state: BracketState; events: ProgressionEvents } {
  const state: BracketState = new Map(bracket.nodes.map((n) => [n.key, emptyNode()] as const));
  const progression = new Progression(bracket, state);
  for (const node of orderedNodes(bracket)) {
    node.sources.forEach((source, index) => {
      if (source.type === 'PARTICIPANT') progression.place(node.key, index === 0 ? 'A' : 'B', source.participantId);
    });
  }
  return { state, events: progression.events };
}

export interface NodeSnapshot {
  key: string;
  teamA: string | null;
  teamB: string | null;
  winner: string | null;
  done: boolean;
  cancelled?: boolean;
}

/** Rebuilds a state from persisted rows (the loser is derived from the winner and the two teams). */
export function stateFromSnapshot(bracket: GeneratedBracket, snapshot: readonly NodeSnapshot[]): BracketState {
  const byKey = new Map(snapshot.map((s) => [s.key, s] as const));
  const state: BracketState = new Map();
  for (const node of bracket.nodes) {
    const row = byKey.get(node.key);
    if (!row) {
      state.set(node.key, emptyNode());
      continue;
    }
    const loser =
      row.done && row.winner !== null && row.teamA !== null && row.teamB !== null
        ? row.winner === row.teamA
          ? row.teamB
          : row.teamA
        : null;
    state.set(node.key, {
      teamA: row.teamA,
      teamB: row.teamB,
      winner: row.winner,
      loser,
      done: row.done,
      cancelled: row.cancelled ?? false,
    });
  }
  return state;
}

export function cloneState(state: BracketState): BracketState {
  return new Map([...state].map(([key, value]) => [key, { ...value }] as const));
}

/**
 * Records the winner of a played node and moves participants on. Returns a new state and the delta;
 * the input state is not modified.
 */
export function applyResult(
  bracket: GeneratedBracket,
  state: BracketState,
  nodeKey: string,
  winnerSlot: Slot,
): { state: BracketState; events: ProgressionEvents } {
  const next = cloneState(state);
  const progression = new Progression(bracket, next);
  const node = progression.node(nodeKey);
  const st = progression.st(nodeKey);
  if (node.isBye) throw new BracketError(`${nodeKey} is a bye and resolves automatically`);
  if (st.cancelled) throw new BracketError(`${nodeKey} was cancelled`);
  if (st.done) throw new BracketError(`${nodeKey} already has a result`);
  if (st.teamA === null || st.teamB === null) throw new BracketError(`${nodeKey} is not ready: both participants are required`);

  const winnerId = winnerSlot === 'A' ? st.teamA : st.teamB;
  const loserId = winnerSlot === 'A' ? st.teamB : st.teamA;
  st.winner = winnerId;
  st.loser = loserId;
  st.done = true;
  progression.route(node, winnerId, loserId, winnerSlot);
  return { state: next, events: progression.events };
}

/**
 * Final placements known so far. Eliminated participants rank by how late they went out; participants
 * eliminated in the same round share a place (e.g. both semifinal losers are 3rd unless a third-place match is played).
 */
export function computePlacements(bracket: GeneratedBracket, state: BracketState): Map<string, number> {
  const placements = new Map<string, number>();
  const { finalKey, resetKey } = bracket;

  const deciderKey = resetKey !== null && state.get(resetKey)?.done ? resetKey : finalKey;
  const decider = deciderKey === null ? undefined : state.get(deciderKey);
  if (!decider?.done || decider.winner === null || decider.loser === null) return placements;
  placements.set(decider.winner, 1);
  placements.set(decider.loser, 2);

  const third = state.get('T-1');
  if (third?.done && third.winner !== null && third.loser !== null) {
    placements.set(third.winner, 3);
    placements.set(third.loser, 4);
  }

  // Participants whose last game was a loss that ends their run, ranked by how late they went out.
  const eliminated: Array<{ id: string; order: number }> = [];
  for (const node of bracket.nodes) {
    if (node.loserNext !== null || node.side === 'GRAND_FINAL' || node.key === 'T-1' || node.key === finalKey) continue;
    const st = state.get(node.key);
    if (st?.done && st.loser !== null) eliminated.push({ id: st.loser, order: node.round });
  }
  eliminated.sort((a, b) => b.order - a.order);

  let taken = placements.size;
  let i = 0;
  while (i < eliminated.length) {
    const order = eliminated[i]!.order;
    let j = i;
    while (j < eliminated.length && eliminated[j]!.order === order) j++;
    for (let k = i; k < j; k++) {
      const entry = eliminated[k]!;
      if (!placements.has(entry.id)) placements.set(entry.id, taken + 1);
    }
    taken += j - i;
    i = j;
  }
  return placements;
}
