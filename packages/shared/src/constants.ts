export const GAME_MODES = ['FIVE_V_FIVE', 'WINGMAN'] as const;
export type GameMode = (typeof GAME_MODES)[number];

/**
 * Game modes the platform can run today. Wingman (2v2) stays in the data model so it can be added later, but it is
 * deliberately NOT implemented: the website shows "Coming Soon" and the API rejects it.
 */
export const ENABLED_GAME_MODES = ['FIVE_V_FIVE'] as const satisfies readonly GameMode[];
export const WINGMAN_COMING_SOON = true;

export function isGameModeEnabled(mode: GameMode): boolean {
  return (ENABLED_GAME_MODES as readonly GameMode[]).includes(mode);
}

/** Default roster size per side. A *default* only: the match engine accepts any size per team (1v1, 2v3, 4v5 …). */
export const DEFAULT_TEAM_SIZE = 5;
export const MAX_TEAM_SIZE = 16;
export const TEAM_SIZE_BY_MODE: Readonly<Record<GameMode, number>> = {
  FIVE_V_FIVE: DEFAULT_TEAM_SIZE,
  WINGMAN: 2,
};

export const TEAM_SLOTS = ['A', 'B'] as const;
export type TeamSlot = (typeof TEAM_SLOTS)[number];

export function otherSlot(slot: TeamSlot): TeamSlot {
  return slot === 'A' ? 'B' : 'A';
}

export const BEST_OF_VALUES = [1, 3, 5] as const;
export type BestOf = (typeof BEST_OF_VALUES)[number];

export const TOURNAMENT_FORMATS = [
  'SINGLE_ELIMINATION',
  'DOUBLE_ELIMINATION',
  'ROUND_ROBIN',
  'SWISS',
] as const;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];

/**
 * Formats the platform can actually run. A format is added here only when its bracket generator
 * AND its tests exist; the API and UI offer nothing else.
 */
export const SUPPORTED_TOURNAMENT_FORMATS: readonly TournamentFormat[] = [
  'SINGLE_ELIMINATION',
  'DOUBLE_ELIMINATION',
];

export const TOURNAMENT_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'RUNNING',
  'PAUSED',
  'FINISHED',
  'CANCELLED',
] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

export const MATCH_STATUSES = [
  'SCHEDULED',
  'WAITING',
  /** Server reserved; players connect and the match controller sets teams, map and rules. No ready check. */
  'LOBBY',
  'VETO',
  /** A controller forced the map: the veto is skipped and the match waits for an explicit start. */
  'MAP_FORCED',
  'CONFIGURING',
  'LIVE',
  'FINISHED',
  'CANCELLED',
  'SERVER_ERROR',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const SERVER_STATUSES = ['ONLINE', 'OFFLINE', 'STARTING', 'READY', 'IN_USE', 'ERROR'] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const LOADOUT_SLOTS = [
  'KNIFE',
  'GLOVES',
  'PISTOL',
  'RIFLE',
  'AWP',
  'SMG',
  'SHOTGUN',
  'MACHINE_GUN',
] as const;
export type LoadoutSlot = (typeof LOADOUT_SLOTS)[number];

export const STARTING_SIDES = ['CT', 'T'] as const;
export type StartingSide = (typeof STARTING_SIDES)[number];

/** Heartbeat contract between plugin and backend (docs/PLUGIN.md). */
export const SERVER_HEARTBEAT_INTERVAL_MS = 10_000;
export const SERVER_OFFLINE_AFTER_MS = 30_000;
/** How long a server stays reserved for a match that has not gone LIVE yet. */
export const SERVER_RESERVATION_TTL_MS = 20 * 60_000;
/** Allowed clock skew between plugin and backend for signed requests. */
export const SIGNATURE_MAX_SKEW_MS = 30_000;

/** SteamID64 of an individual account: 17 digits starting with 7656119. */
export const STEAM_ID64_REGEX = /^7656119\d{10}$/;

export function isSteamId64(value: string): boolean {
  return STEAM_ID64_REGEX.test(value);
}

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;
