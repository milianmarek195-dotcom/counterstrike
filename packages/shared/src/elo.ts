/**
 * Elo calculation for team matches. Pure and deterministic: everything is computed server-side from
 * stored ratings and the validated match outcome – the client never supplies a rating.
 *
 * Team rating = mean of the players' ratings. Every player's change is based on the *team* expectation,
 * scaled by the player's own K-factor (new players move faster than veterans).
 */

export interface EloConfig {
  startElo: number;
  /** Ratings never drop below this value. */
  floor: number;
  /** Logistic scale (400 = classic Elo). */
  scale: number;
  /** Matches during which the placement K-factor applies. */
  placementMatches: number;
  kPlacement: number;
  kDefault: number;
  /** K-factor for players at or above `highEloThreshold`. */
  kHighElo: number;
  highEloThreshold: number;
}

export const DEFAULT_ELO_CONFIG: Readonly<EloConfig> = {
  startElo: 1000,
  floor: 100,
  scale: 400,
  placementMatches: 10,
  kPlacement: 40,
  kDefault: 28,
  kHighElo: 20,
  highEloThreshold: 1800,
};

export type EloOutcome = 'WIN' | 'LOSS' | 'DRAW';

export interface EloPlayerInput {
  userId: string;
  elo: number;
  /** Rated matches played before this one. */
  matchesPlayed: number;
}

export interface EloResultRow {
  userId: string;
  outcome: EloOutcome;
  eloBefore: number;
  eloAfter: number;
  /** Actual applied change (after the floor), eloAfter - eloBefore. */
  delta: number;
  kFactor: number;
  expectedScore: number;
  ownTeamElo: number;
  opponentTeamElo: number;
}

export interface EloMatchResult {
  teamA: EloResultRow[];
  teamB: EloResultRow[];
  teamAElo: number;
  teamBElo: number;
}

export function expectedScore(ownElo: number, opponentElo: number, scale = DEFAULT_ELO_CONFIG.scale): number {
  return 1 / (1 + Math.pow(10, (opponentElo - ownElo) / scale));
}

export function teamElo(players: readonly Pick<EloPlayerInput, 'elo'>[]): number {
  if (players.length === 0) throw new RangeError('A team needs at least one player');
  return players.reduce((sum, p) => sum + p.elo, 0) / players.length;
}

export function kFactorFor(player: Pick<EloPlayerInput, 'elo' | 'matchesPlayed'>, config: EloConfig): number {
  if (player.matchesPlayed < config.placementMatches) return config.kPlacement;
  return player.elo >= config.highEloThreshold ? config.kHighElo : config.kDefault;
}

function score(outcome: EloOutcome): number {
  return outcome === 'WIN' ? 1 : outcome === 'LOSS' ? 0 : 0.5;
}

function invert(outcome: EloOutcome): EloOutcome {
  return outcome === 'WIN' ? 'LOSS' : outcome === 'LOSS' ? 'WIN' : 'DRAW';
}

function rate(
  players: readonly EloPlayerInput[],
  ownTeamElo: number,
  opponentTeamElo: number,
  outcome: EloOutcome,
  config: EloConfig,
): EloResultRow[] {
  const expected = expectedScore(ownTeamElo, opponentTeamElo, config.scale);
  return players.map((p) => {
    const k = kFactorFor(p, config);
    let change = Math.round(k * (score(outcome) - expected));
    // A decisive result always moves the rating by at least one point.
    if (outcome === 'WIN' && change < 1) change = 1;
    if (outcome === 'LOSS' && change > -1) change = -1;
    const eloAfter = Math.max(config.floor, p.elo + change);
    return {
      userId: p.userId,
      outcome,
      eloBefore: p.elo,
      eloAfter,
      delta: eloAfter - p.elo,
      kFactor: k,
      expectedScore: expected,
      ownTeamElo: Math.round(ownTeamElo),
      opponentTeamElo: Math.round(opponentTeamElo),
    };
  });
}

export function calculateMatchElo(
  teamA: readonly EloPlayerInput[],
  teamB: readonly EloPlayerInput[],
  outcomeForA: EloOutcome,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): EloMatchResult {
  const a = teamElo(teamA);
  const b = teamElo(teamB);
  return {
    teamA: rate(teamA, a, b, outcomeForA, config),
    teamB: rate(teamB, b, a, invert(outcomeForA), config),
    teamAElo: Math.round(a),
    teamBElo: Math.round(b),
  };
}
