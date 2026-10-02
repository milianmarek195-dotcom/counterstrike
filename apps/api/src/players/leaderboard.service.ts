import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import type { GameMode, Prisma } from '@celtist/database';
import { deriveStats, winRate } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent } from '../common/domain-events.js';
import { PrismaService } from '../database/prisma.service.js';
import { RankTiersService } from '../ranking/rank-tiers.service.js';
import { RedisService } from '../redis/redis.service.js';

export type RankingScope = 'global' | '30d' | 'tournament' | 'wingman';
export type RankingSort = 'elo' | 'wins' | 'winrate' | 'kd' | 'kills';

export interface RankingQuery {
  scope: RankingScope;
  sort: RankingSort;
  page: number;
  pageSize: number;
  minMatches: number;
}

interface Row {
  userId: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  elo: number;
  matches: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  rounds: number;
  damage: number;
  headshots: number;
}

const CACHE_PREFIX = 'ranking:board:';
const CACHE_SECONDS = 60;

/**
 * Leaderboards. Never "kills only": the default order is Elo, and every sort key is a rate or rating except raw
 * kills, which is available but not the headline. Window scopes (30 days, tournaments) are aggregated from match
 * rows; the all-time scopes read the maintained rank rows. Results are cached for a minute and dropped whenever a match
 * finishes.
 */
@Injectable()
export class LeaderboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tiers: RankTiersService,
    private readonly clock: Clock,
  ) {}

  @OnEvent(DomainEvent.RankingChanged)
  async onRankingChanged(): Promise<void> {
    await this.redis.deleteByPrefix(CACHE_PREFIX).catch(() => undefined);
  }

  async leaderboard(query: RankingQuery) {
    return this.redis.remember(`${CACHE_PREFIX}${query.scope}:${query.sort}:${query.minMatches}`, CACHE_SECONDS, async () => {
      const rows = await this.load(query);
      const tiers = await this.tiers.tiers();
      const scored = rows.map((row) => ({ row, ...deriveStats(row), winRate: winRate(row.wins, row.matches) }));
      scored.sort((a, b) => this.compare(query.sort, a, b));
      return {
        scope: query.scope,
        sort: query.sort,
        entries: await Promise.all(
          scored.map(async (s, index) => ({
            position: index + 1,
            steamId: s.row.steamId,
            displayName: s.row.displayName,
            avatarUrl: s.row.avatarUrl,
            elo: s.row.elo,
            rank: await this.tiers.badgeFor(s.row.elo, tiers),
            matches: s.row.matches,
            wins: s.row.wins,
            losses: s.row.losses,
            winRate: s.winRate,
            kills: s.row.kills,
            deaths: s.row.deaths,
            kd: s.kd,
            adr: s.adr,
            hsPercent: s.hsPercent,
          })),
        ),
      };
    }).then((full) => ({
      scope: full.scope,
      sort: full.sort,
      total: full.entries.length,
      page: query.page,
      pageSize: query.pageSize,
      entries: full.entries.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
    }));
  }

  private compare(sort: RankingSort, a: { row: Row; kd: number; winRate: number }, b: { row: Row; kd: number; winRate: number }): number {
    const key = (x: typeof a): number =>
      sort === 'elo' ? x.row.elo : sort === 'wins' ? x.row.wins : sort === 'winrate' ? x.winRate : sort === 'kd' ? x.kd : x.row.kills;
    // Ties: higher Elo first, then more matches, then name – a stable, fair order.
    return key(b) - key(a) || b.row.elo - a.row.elo || b.row.matches - a.row.matches || a.row.displayName.localeCompare(b.row.displayName);
  }

  private async load(query: RankingQuery): Promise<Row[]> {
    const mode: GameMode = query.scope === 'wingman' ? 'WINGMAN' : 'FIVE_V_FIVE';
    if (query.scope === 'global' || query.scope === 'wingman') return this.allTime(mode, query.minMatches);
    return this.windowed(mode, query.scope === '30d' ? { since: new Date(this.clock.nowMs() - 30 * 24 * 60 * 60_000) } : { kind: 'TOURNAMENT' }, query.minMatches);
  }

  private async allTime(mode: GameMode, minMatches: number): Promise<Row[]> {
    const ranks = await this.prisma.playerRank.findMany({
      where: { mode, matches: { gte: Math.max(1, minMatches) } },
      include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } },
    });
    const stats = await this.prisma.playerStats.findMany({ where: { mode, userId: { in: ranks.map((r) => r.userId) } } });
    const byUser = new Map(stats.map((s) => [s.userId, s] as const));
    return ranks.map((r) => {
      const s = byUser.get(r.userId);
      return {
        userId: r.userId,
        steamId: r.user.steamId,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        elo: r.elo,
        matches: r.matches,
        wins: r.wins,
        losses: r.losses,
        kills: s?.kills ?? 0,
        deaths: s?.deaths ?? 0,
        rounds: s?.rounds ?? 0,
        damage: s?.damage ?? 0,
        headshots: s?.headshots ?? 0,
      };
    });
  }

  private async windowed(mode: GameMode, filter: { since?: Date; kind?: 'TOURNAMENT' }, minMatches: number): Promise<Row[]> {
    const where: Prisma.MatchPlayerWhereInput = {
      mode,
      rounds: { gt: 0 },
      finishedAt: { not: null, ...(filter.since ? { gte: filter.since } : {}) },
      ...(filter.kind ? { match: { kind: filter.kind } } : {}),
    };
    const [sums, wins] = await Promise.all([
      this.prisma.matchPlayer.groupBy({ by: ['userId'], where, _count: { _all: true }, _sum: { kills: true, deaths: true, rounds: true, damage: true, headshots: true } }),
      this.prisma.matchPlayer.groupBy({ by: ['userId'], where: { ...where, won: true }, _count: { _all: true } }),
    ]);
    const winsBy = new Map(wins.map((w) => [w.userId, w._count._all] as const));
    const eligible = sums.filter((s) => s._count._all >= Math.max(1, minMatches));
    const users = await this.prisma.user.findMany({
      where: { id: { in: eligible.map((s) => s.userId) } },
      select: { id: true, steamId: true, displayName: true, avatarUrl: true, ranks: { where: { mode }, select: { elo: true } } },
    });
    const userBy = new Map(users.map((u) => [u.id, u] as const));
    return eligible.map((s) => {
      const u = userBy.get(s.userId)!;
      const w = winsBy.get(s.userId) ?? 0;
      return {
        userId: s.userId,
        steamId: u.steamId,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        elo: u.ranks[0]?.elo ?? 1000,
        matches: s._count._all,
        wins: w,
        losses: s._count._all - w,
        kills: s._sum.kills ?? 0,
        deaths: s._sum.deaths ?? 0,
        rounds: s._sum.rounds ?? 0,
        damage: s._sum.damage ?? 0,
        headshots: s._sum.headshots ?? 0,
      };
    });
  }
}
