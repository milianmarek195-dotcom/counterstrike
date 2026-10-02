import type { MatchStatus, ServerStatus, TournamentStatus } from './constants.js';

/**
 * Transition tables for the three state machines (see docs/ARCHITECTURE.md §9). Services must check
 * `canTransition` before changing a status; the database update itself additionally guards on the
 * expected previous status (compare-and-set), so concurrent callers cannot both succeed.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export class InvalidTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${machine} transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return table[from].includes(to);
}

export function assertTransition<S extends string>(
  machine: string,
  table: TransitionTable<S>,
  from: S,
  to: S,
): void {
  if (!canTransition(table, from, to)) throw new InvalidTransitionError(machine, from, to);
}

export const TOURNAMENT_TRANSITIONS: TransitionTable<TournamentStatus> = {
  DRAFT: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['RUNNING', 'DRAFT', 'CANCELLED'],
  RUNNING: ['PAUSED', 'FINISHED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  FINISHED: [],
  CANCELLED: [],
};

/**
 * Match lifecycle. There is no ready check: a controller (party leader or admin) steers the match.
 *   WAITING   teams known, no server yet
 *   LOBBY     server reserved, players connect, the controller assigns teams / chooses the map
 *   VETO      optional map veto in progress
 *   MAP_FORCED a controller forced the map (veto skipped); waits for the explicit start
 *   CONFIGURING the server loads map and roster
 */
export const MATCH_TRANSITIONS: TransitionTable<MatchStatus> = {
  SCHEDULED: ['WAITING', 'CANCELLED'],
  WAITING: ['LOBBY', 'MAP_FORCED', 'CANCELLED', 'FINISHED'],
  LOBBY: ['WAITING', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'CANCELLED', 'FINISHED'],
  VETO: ['CONFIGURING', 'MAP_FORCED', 'LOBBY', 'WAITING', 'CANCELLED', 'FINISHED'],
  MAP_FORCED: ['CONFIGURING', 'VETO', 'LOBBY', 'WAITING', 'CANCELLED', 'FINISHED'],
  CONFIGURING: ['LIVE', 'SERVER_ERROR', 'CANCELLED', 'FINISHED'],
  LIVE: ['FINISHED', 'SERVER_ERROR', 'CANCELLED'],
  SERVER_ERROR: ['LIVE', 'CONFIGURING', 'CANCELLED', 'FINISHED'],
  FINISHED: [],
  CANCELLED: [],
};

export const SERVER_TRANSITIONS: TransitionTable<ServerStatus> = {
  OFFLINE: ['STARTING', 'READY', 'IN_USE', 'ERROR', 'ONLINE'],
  STARTING: ['READY', 'ERROR', 'OFFLINE', 'ONLINE'],
  READY: ['IN_USE', 'ONLINE', 'ERROR', 'OFFLINE', 'STARTING'],
  IN_USE: ['READY', 'ERROR', 'OFFLINE'],
  ONLINE: ['READY', 'OFFLINE', 'ERROR', 'STARTING'],
  ERROR: ['READY', 'STARTING', 'OFFLINE', 'ONLINE'],
};

export const MATCH_TERMINAL_STATUSES: readonly MatchStatus[] = ['FINISHED', 'CANCELLED'];
export const TOURNAMENT_TERMINAL_STATUSES: readonly TournamentStatus[] = ['FINISHED', 'CANCELLED'];

/** Match states in which a server is reserved or hosting. */
export const MATCH_SERVER_BOUND_STATUSES: readonly MatchStatus[] = [
  'LOBBY',
  'VETO',
  'MAP_FORCED',
  'CONFIGURING',
  'LIVE',
  'SERVER_ERROR',
];

/** States in which teams, map and rules may still be changed by a controller without risking an inconsistent match. */
export const MATCH_SETUP_STATUSES: readonly MatchStatus[] = ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'];

export function isMatchTerminal(status: MatchStatus): boolean {
  return MATCH_TERMINAL_STATUSES.includes(status);
}

/** Status shown on bracket cards and lists (the detailed lifecycle states collapse into six). */
export type DisplayMatchStatus = 'SCHEDULED' | 'WAITING' | 'READY' | 'LIVE' | 'FINISHED' | 'CANCELLED';

export function displayMatchStatus(status: MatchStatus): DisplayMatchStatus {
  switch (status) {
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'WAITING':
      return 'WAITING';
    case 'LOBBY':
    case 'VETO':
    case 'MAP_FORCED':
    case 'CONFIGURING':
      return 'READY';
    case 'LIVE':
    case 'SERVER_ERROR':
      return 'LIVE';
    case 'FINISHED':
      return 'FINISHED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}
