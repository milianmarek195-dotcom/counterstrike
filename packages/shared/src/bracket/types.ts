import type { TournamentFormat } from '../constants.js';

export type BracketSide = 'UPPER' | 'LOWER' | 'GRAND_FINAL' | 'GROUP';
export type Slot = 'A' | 'B';

export interface BracketParticipant {
  id: string;
  /** 1 = best. Gaps are allowed; participants are ranked by seed. */
  seed: number;
}

/** Where a slot of a bracket node gets its participant from. */
export type SlotSource =
  | { type: 'PARTICIPANT'; participantId: string }
  | { type: 'WINNER_OF'; nodeKey: string }
  | { type: 'LOSER_OF'; nodeKey: string }
  /** Participant that occupied `slot` of `nodeKey` (grand-final reset: same finalists, same slots). */
  | { type: 'CARRY'; nodeKey: string; slot: Slot }
  /** The slot can never be filled (bye). */
  | { type: 'EMPTY' };

export interface BracketLink {
  nodeKey: string;
  slot: Slot;
}

export interface BracketNode {
  /** Stable identifier, e.g. U1-0 (upper round 1, position 0), L3-1, GF-1, GF-2, T-1. */
  key: string;
  side: BracketSide;
  /** 1-based round within the side. */
  round: number;
  /** 0-based position within the round. */
  position: number;
  label: string;
  sources: [SlotSource, SlotSource];
  /** Exactly one slot can never be filled: no game is played, the other participant advances. */
  isBye: boolean;
  winnerNext: BracketLink | null;
  loserNext: BracketLink | null;
}

export interface BracketOptions {
  /** Double elimination: play a second grand final if the lower-bracket winner wins the first. */
  grandFinalReset: boolean;
  /** Single elimination: play a match for third place (needs ≥ 4 participants). */
  thirdPlaceMatch: boolean;
}

export const DEFAULT_BRACKET_OPTIONS: Readonly<BracketOptions> = {
  grandFinalReset: true,
  thirdPlaceMatch: false,
};

export interface GeneratedBracket {
  format: TournamentFormat;
  participantCount: number;
  /** Bracket size: next power of two ≥ participantCount (0 for formats without brackets). */
  size: number;
  nodes: BracketNode[];
  /** Node whose winner is the champion (before an optional reset). */
  finalKey: string | null;
  /** Second grand final, only for double elimination with reset. */
  resetKey: string | null;
}

export interface BracketGenerator {
  readonly format: TournamentFormat;
  generate(participants: readonly BracketParticipant[], options?: Partial<BracketOptions>): GeneratedBracket;
}

export class BracketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BracketError';
  }
}
