import type { TeamSlot } from './constants.js';
import type { MapResultPayload } from './schemas/server-gateway.js';

/**
 * The server is the only source of results, but its data is never trusted blindly: every report is checked
 * against what the platform already knows about the match before anything is stored or any rating changes.
 *
 * Hard errors reject the report; anomalies (soft inconsistencies) are stored with the event for review.
 */
export interface ResultValidationContext {
  matchId: string;
  expectedMapNumber: number;
  /** Everyone authorised for this match (starters and substitutes) with their team. */
  roster: ReadonlyArray<{ steamId: string; team: TeamSlot }>;
  /** Rounds a team needs to win in regulation (13 / 9). */
  roundsToWin: number;
  allowDraw: boolean;
  nowMs: number;
  maxClockSkewMs: number;
}

export type ResultValidation =
  | { ok: true; winner: TeamSlot | null; anomalies: string[] }
  | { ok: false; errors: string[] };

const MAX_DAMAGE_PER_ROUND = 800;
const MIN_SECONDS_PER_ROUND = 8;

export function validateMapResult(ctx: ResultValidationContext, result: MapResultPayload): ResultValidation {
  const errors: string[] = [];
  const anomalies: string[] = [];

  if (result.matchId !== ctx.matchId) errors.push('MATCH_MISMATCH: the report belongs to another match');
  if (result.mapNumber !== ctx.expectedMapNumber) {
    errors.push(`MAP_NUMBER_MISMATCH: expected map ${ctx.expectedMapNumber}, got ${result.mapNumber}`);
  }

  const { scoreA, scoreB, rounds } = result;
  if (scoreA + scoreB !== rounds) errors.push(`ROUNDS_MISMATCH: ${scoreA}:${scoreB} does not add up to ${rounds} rounds`);
  if (rounds < 1) errors.push('NO_ROUNDS: no rounds were played');
  if (scoreA === scoreB && !ctx.allowDraw) errors.push('DRAW_NOT_ALLOWED: this match needs a winner');
  if (result.endReason === 'NORMAL' && Math.max(scoreA, scoreB) < ctx.roundsToWin) {
    errors.push(`SCORE_IMPLAUSIBLE: a normal finish needs at least ${ctx.roundsToWin} rounds for the winner`);
  }

  const startedMs = result.startedAt.getTime();
  const endedMs = result.endedAt.getTime();
  if (endedMs < startedMs) errors.push('TIME_TRAVEL: the map ended before it started');
  if (endedMs > ctx.nowMs + ctx.maxClockSkewMs) errors.push('FUTURE_END: the end time lies in the future');
  if (result.endReason === 'NORMAL' && rounds > 0 && endedMs - startedMs < rounds * MIN_SECONDS_PER_ROUND * 1000) {
    errors.push('DURATION_IMPLAUSIBLE: the map was too short for the reported rounds');
  }

  const rosterBySteamId = new Map(ctx.roster.map((r) => [r.steamId, r.team] as const));
  const seen = new Set<string>();
  const kills: Record<TeamSlot, number> = { A: 0, B: 0 };
  const deaths: Record<TeamSlot, number> = { A: 0, B: 0 };
  const reportedTeams = new Set<TeamSlot>();

  for (const player of result.players) {
    const label = `player ${player.steamId}`;
    if (seen.has(player.steamId)) errors.push(`DUPLICATE_PLAYER: ${label} is listed twice`);
    seen.add(player.steamId);

    const rosterTeam = rosterBySteamId.get(player.steamId);
    if (rosterTeam === undefined) errors.push(`UNKNOWN_PLAYER: ${label} is not part of this match`);
    else if (rosterTeam !== player.team) errors.push(`WRONG_TEAM: ${label} belongs to team ${rosterTeam}`);
    reportedTeams.add(player.team);

    if (player.rounds > rounds) errors.push(`PLAYER_ROUNDS: ${label} played more rounds than the map had`);
    if (player.headshots > player.kills) errors.push(`HEADSHOTS: ${label} has more headshots than kills`);
    if (player.mvps > player.rounds) errors.push(`MVPS: ${label} has more MVPs than rounds`);
    if (player.damage > player.rounds * MAX_DAMAGE_PER_ROUND) errors.push(`DAMAGE: ${label} dealt implausible damage`);
    if (player.utilityDamage > player.damage) errors.push(`UTILITY_DAMAGE: ${label} has more utility than total damage`);
    if (player.entryKills > player.kills) errors.push(`ENTRY_KILLS: ${label} has more entry kills than kills`);
    if (player.entryDeaths > player.deaths) errors.push(`ENTRY_DEATHS: ${label} has more entry deaths than deaths`);
    if (player.clutches > player.rounds) errors.push(`CLUTCHES: ${label} has more clutches than rounds`);
    if (player.kills + player.assists > player.rounds * 10) errors.push(`KILLS: ${label} has implausible kills`);

    kills[player.team] += player.kills;
    deaths[player.team] += player.deaths;
  }

  if (!reportedTeams.has('A') || !reportedTeams.has('B')) errors.push('MISSING_TEAM: both teams need at least one reported player');

  // Soft checks: possible with leavers/rejoins or counting differences, worth a look but not a rejection.
  if (kills.A > deaths.B + 2) anomalies.push(`Team A kills (${kills.A}) exceed team B deaths (${deaths.B})`);
  if (kills.B > deaths.A + 2) anomalies.push(`Team B kills (${kills.B}) exceed team A deaths (${deaths.A})`);
  const rosterStarters = ctx.roster.length;
  if (result.players.length < rosterStarters / 2) anomalies.push('Fewer than half of the rostered players were reported');

  if (errors.length > 0) return { ok: false, errors };
  const winner: TeamSlot | null = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : null;
  return { ok: true, winner, anomalies };
}
