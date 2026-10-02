import type { BestOf, TeamSlot } from './constants.js';

export function mapsToWin(bestOf: BestOf): number {
  return Math.ceil(bestOf / 2);
}

export interface SeriesState {
  winsA: number;
  winsB: number;
  /** Winner of the series, or null while it is undecided. */
  winner: TeamSlot | null;
  /** Number of the map to play next, or null when the series is over. */
  nextMapNumber: number | null;
}

/** Series status from the winners of the maps played so far (null = draw, which counts for nobody). */
export function seriesState(bestOf: BestOf, mapWinners: ReadonlyArray<TeamSlot | null>): SeriesState {
  const winsA = mapWinners.filter((w) => w === 'A').length;
  const winsB = mapWinners.filter((w) => w === 'B').length;
  const needed = mapsToWin(bestOf);
  const winner: TeamSlot | null = winsA >= needed ? 'A' : winsB >= needed ? 'B' : null;
  const played = mapWinners.length;
  const nextMapNumber = winner !== null || played >= bestOf ? null : played + 1;
  return { winsA, winsB, winner, nextMapNumber };
}

/** Rounds a team must win in regulation (first to N): 13 for MR12 competitive, 9 for MR8 wingman. */
export function roundsToWin(mode: 'FIVE_V_FIVE' | 'WINGMAN'): number {
  return mode === 'WINGMAN' ? 9 : 13;
}
