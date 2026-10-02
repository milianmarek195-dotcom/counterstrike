export interface RankTier {
  key: string;
  name: string;
  /** Lowest Elo that belongs to this tier. */
  minElo: number;
  /** CSS colour used for the rank badge. */
  color: string;
  position: number;
}

/** Defaults seeded into the database; the admin panel can change them. */
export const DEFAULT_RANK_TIERS: readonly RankTier[] = [
  { key: 'bronze', name: 'Bronze', minElo: 0, color: '#a16a3c', position: 1 },
  { key: 'silver', name: 'Silver', minElo: 900, color: '#8f9bab', position: 2 },
  { key: 'gold', name: 'Gold', minElo: 1100, color: '#d4a017', position: 3 },
  { key: 'platinum', name: 'Platinum', minElo: 1250, color: '#3fa7a0', position: 4 },
  { key: 'diamond', name: 'Diamond', minElo: 1400, color: '#4a8fe7', position: 5 },
  { key: 'elite', name: 'Elite', minElo: 1600, color: '#8b5cf6', position: 6 },
  { key: 'master', name: 'Master', minElo: 1800, color: '#e5484d', position: 7 },
];

function sorted(tiers: readonly RankTier[]): RankTier[] {
  return [...tiers].sort((a, b) => a.minElo - b.minElo);
}

/** Highest tier whose threshold the rating reaches. */
export function resolveRank(elo: number, tiers: readonly RankTier[] = DEFAULT_RANK_TIERS): RankTier {
  const list = sorted(tiers);
  if (list.length === 0) throw new RangeError('At least one rank tier is required');
  let result = list[0]!;
  for (const tier of list) {
    if (elo >= tier.minElo) result = tier;
    else break;
  }
  return result;
}

/** The tier after `current`, or null if `current` is the highest. */
export function nextRank(current: RankTier, tiers: readonly RankTier[] = DEFAULT_RANK_TIERS): RankTier | null {
  const list = sorted(tiers);
  const index = list.findIndex((t) => t.key === current.key);
  return index >= 0 && index < list.length - 1 ? list[index + 1]! : null;
}

export function validateRankTiers(tiers: readonly RankTier[]): string[] {
  const errors: string[] = [];
  if (tiers.length === 0) return ['At least one tier is required'];
  const list = sorted(tiers);
  if (list[0]!.minElo !== 0) errors.push('The lowest tier must start at 0 Elo');
  const keys = new Set<string>();
  const mins = new Set<number>();
  for (const t of list) {
    if (keys.has(t.key)) errors.push(`Duplicate tier key "${t.key}"`);
    if (mins.has(t.minElo)) errors.push(`Duplicate threshold ${t.minElo}`);
    if (!Number.isInteger(t.minElo) || t.minElo < 0) errors.push(`Invalid threshold for "${t.key}"`);
    keys.add(t.key);
    mins.add(t.minElo);
  }
  return errors;
}
