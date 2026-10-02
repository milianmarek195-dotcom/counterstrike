export interface CombatStats {
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  mvps: number;
  flashAssists: number;
  utilityDamage: number;
  clutches: number;
  entryKills: number;
  entryDeaths: number;
}

export const EMPTY_COMBAT_STATS: Readonly<CombatStats> = {
  rounds: 0,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshots: 0,
  damage: 0,
  mvps: 0,
  flashAssists: 0,
  utilityDamage: 0,
  clutches: 0,
  entryKills: 0,
  entryDeaths: 0,
};

export function addCombatStats(a: CombatStats, b: CombatStats): CombatStats {
  return {
    rounds: a.rounds + b.rounds,
    kills: a.kills + b.kills,
    deaths: a.deaths + b.deaths,
    assists: a.assists + b.assists,
    headshots: a.headshots + b.headshots,
    damage: a.damage + b.damage,
    mvps: a.mvps + b.mvps,
    flashAssists: a.flashAssists + b.flashAssists,
    utilityDamage: a.utilityDamage + b.utilityDamage,
    clutches: a.clutches + b.clutches,
    entryKills: a.entryKills + b.entryKills,
    entryDeaths: a.entryDeaths + b.entryDeaths,
  };
}

export function sumCombatStats(rows: readonly CombatStats[]): CombatStats {
  return rows.reduce(addCombatStats, { ...EMPTY_COMBAT_STATS });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Kill/death ratio; with zero deaths it equals the kill count (never Infinity/NaN). */
export function killDeathRatio(kills: number, deaths: number): number {
  return deaths === 0 ? kills : round2(kills / deaths);
}

/** Average damage per round. */
export function averageDamagePerRound(damage: number, rounds: number): number {
  return rounds === 0 ? 0 : round2(damage / rounds);
}

/** Headshot percentage (0–100) of kills. */
export function headshotPercentage(headshots: number, kills: number): number {
  return kills === 0 ? 0 : round2((headshots / kills) * 100);
}

/** Win rate in percent (0–100). Draws count as matches played. */
export function winRate(wins: number, matches: number): number {
  return matches === 0 ? 0 : round2((wins / matches) * 100);
}

export interface DerivedStats {
  kd: number;
  adr: number;
  hsPercent: number;
}

export function deriveStats(stats: Pick<CombatStats, 'kills' | 'deaths' | 'damage' | 'rounds' | 'headshots'>): DerivedStats {
  return {
    kd: killDeathRatio(stats.kills, stats.deaths),
    adr: averageDamagePerRound(stats.damage, stats.rounds),
    hsPercent: headshotPercentage(stats.headshots, stats.kills),
  };
}
