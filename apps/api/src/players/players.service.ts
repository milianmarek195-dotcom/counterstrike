import { Injectable } from '@nestjs/common';
import type { GameMode, Prisma } from '@celtist/database';
import { GAME_MODES, deriveStats, winRate } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RankTiersService } from '../ranking/rank-tiers.service.js';
import { RedisService } from '../redis/redis.service.js';

const DAY_MS = 24 * 60 * 60_000;

export interface StatsBlock {
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  damage: number;
  mvps: number;
  /** Kills by weapon class (humans only; bots never count). */
  killsAwp: number;
  killsAk47: number;
  killsPistol: number;
  kd: number;
  adr: number;
  hsPercent: number;
}

function block(raw: { matches: number; wins: number; losses: number; rounds: number; kills: number; deaths: number; assists: number; headshots: number; damage: number; mvps: number; killsAwp: number; killsAk47: number; killsPistol: number }): StatsBlock {
  return { ...raw, winRate: winRate(raw.wins, raw.matches), ...deriveStats(raw) };
}

@Injectable()
export class PlayersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tiers: RankTiersService,
    private readonly clock: Clock,
  ) {}

  async search(query: { q?: string; page: number; pageSize: number }) {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = q
      ? { OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { steamId: q }] }
      : {};
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { ranks: { where: { mode: 'FIVE_V_FIVE' } } },
      }),
    ]);
    const tiers = await this.tiers.tiers();
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      players: await Promise.all(
        users.map(async (u) => ({
          steamId: u.steamId,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl,
          elo: u.ranks[0]?.elo ?? null,
          rank: u.ranks[0] ? await this.tiers.badgeFor(u.ranks[0].elo, tiers) : null,
        })),
      ),
    };
  }

  async byIdentifier(steamId: string) {
    const user = await this.prisma.user.findUnique({
      where: { steamId },
      include: { steamProfile: true },
    });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    return user;
  }

  /** Everything the profile page needs in one call: identity, ranks, overall/30-day numbers and the last match. */
  async profile(steamId: string) {
    const user = await this.byIdentifier(steamId);
    const tiers = await this.tiers.tiers();

    const [ranks, stats, tournamentCount, last] = await Promise.all([
      this.prisma.playerRank.findMany({ where: { userId: user.id } }),
      this.prisma.playerStats.findMany({ where: { userId: user.id } }),
      this.prisma.tournamentTeamMember.count({ where: { userId: user.id } }),
      this.lastMatch(user.id),
    ]);

    const modes: Record<string, unknown> = {};
    for (const mode of GAME_MODES) {
      const rank = ranks.find((r) => r.mode === mode);
      const s = stats.find((x) => x.mode === mode);
      if (!rank) continue;
      const position = rank.matches > 0 ? (await this.prisma.playerRank.count({ where: { mode, matches: { gt: 0 }, elo: { gt: rank.elo } } })) + 1 : null;
      modes[mode] = {
        elo: rank.elo,
        peakElo: rank.peakElo,
        rank: await this.tiers.badgeFor(rank.elo, tiers),
        position,
        streak: rank.currentStreak,
        bestWinStreak: rank.bestWinStreak,
        overall: block({
          matches: rank.matches,
          wins: rank.wins,
          losses: rank.losses,
          rounds: s?.rounds ?? 0,
          kills: s?.kills ?? 0,
          deaths: s?.deaths ?? 0,
          assists: s?.assists ?? 0,
          headshots: s?.headshots ?? 0,
          killsAwp: s?.killsAwp ?? 0,
          killsAk47: s?.killsAk47 ?? 0,
          killsPistol: s?.killsPistol ?? 0,
          damage: s?.damage ?? 0,
          mvps: s?.mvps ?? 0,
        }),
        last30Days: await this.window(user.id, mode, 30),
      };
    }
    return {
      steamId: user.steamId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      memberSince: user.createdAt,
      steam: user.steamProfile
        ? { profileUrl: user.steamProfile.profileUrl, countryCode: user.steamProfile.countryCode, accountCreatedAt: user.steamProfile.accountCreatedAt }
        : null,
      modes,
      tournaments: tournamentCount,
      lastMatch: last,
    };
  }

  /** Aggregated numbers of the matches finished in the last `days` days. */
  async window(userId: string, mode: GameMode, days: number): Promise<StatsBlock> {
    const since = new Date(this.clock.nowMs() - days * DAY_MS);
    const where = { userId, mode, finishedAt: { gte: since }, rounds: { gt: 0 } } satisfies Prisma.MatchPlayerWhereInput;
    const [sum, wins, matches] = await Promise.all([
      this.prisma.matchPlayer.aggregate({ where, _sum: { rounds: true, kills: true, deaths: true, assists: true, headshots: true, damage: true, mvps: true, killsAwp: true, killsAk47: true, killsPistol: true } }),
      this.prisma.matchPlayer.count({ where: { ...where, won: true } }),
      this.prisma.matchPlayer.count({ where }),
    ]);
    return block({
      matches,
      wins,
      losses: matches - wins,
      rounds: sum._sum.rounds ?? 0,
      kills: sum._sum.kills ?? 0,
      deaths: sum._sum.deaths ?? 0,
      assists: sum._sum.assists ?? 0,
      headshots: sum._sum.headshots ?? 0,
      killsAwp: sum._sum.killsAwp ?? 0,
      killsAk47: sum._sum.killsAk47 ?? 0,
      killsPistol: sum._sum.killsPistol ?? 0,
      damage: sum._sum.damage ?? 0,
      mvps: sum._sum.mvps ?? 0,
    });
  }

  async stats(steamId: string, window: 'overall' | '30d' | 'last', mode?: GameMode) {
    const user = await this.byIdentifier(steamId);
    if (window === 'last') return { window, lastMatch: await this.lastMatch(user.id) };
    const modes = mode ? [mode] : [...GAME_MODES];
    const result: Record<string, StatsBlock> = {};
    for (const m of modes) {
      if (window === '30d') {
        result[m] = await this.window(user.id, m, 30);
        continue;
      }
      const [rank, stats] = await Promise.all([
        this.prisma.playerRank.findUnique({ where: { userId_mode: { userId: user.id, mode: m } } }),
        this.prisma.playerStats.findUnique({ where: { userId_mode: { userId: user.id, mode: m } } }),
      ]);
      result[m] = block({
        matches: rank?.matches ?? 0,
        wins: rank?.wins ?? 0,
        losses: rank?.losses ?? 0,
        rounds: stats?.rounds ?? 0,
        kills: stats?.kills ?? 0,
        deaths: stats?.deaths ?? 0,
        assists: stats?.assists ?? 0,
        headshots: stats?.headshots ?? 0,
        killsAwp: stats?.killsAwp ?? 0,
        killsAk47: stats?.killsAk47 ?? 0,
        killsPistol: stats?.killsPistol ?? 0,
        damage: stats?.damage ?? 0,
        mvps: stats?.mvps ?? 0,
      });
    }
    return { window, modes: result };
  }

  async lastMatch(userId: string) {
    const row = await this.prisma.matchPlayer.findFirst({
      where: { userId, finishedAt: { not: null }, match: { status: 'FINISHED' } },
      orderBy: { finishedAt: 'desc' },
      include: { ...matchInclude },
    });
    return row ? this.toHistoryRow(row) : null;
  }

  /** Paginated match history: date, map, teams, score, result, K/D, ADR, Elo change. */
  async history(steamId: string, page: number, pageSize: number) {
    const user = await this.byIdentifier(steamId);
    const where = { userId: user.id, finishedAt: { not: null }, match: { status: 'FINISHED' as const } };
    const [total, rows] = await Promise.all([
      this.prisma.matchPlayer.count({ where }),
      this.prisma.matchPlayer.findMany({ where, orderBy: { finishedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { ...matchInclude } }),
    ]);
    return { total, page, pageSize, matches: rows.map((r) => this.toHistoryRow(r)) };
  }

  async tournaments(steamId: string) {
    const user = await this.byIdentifier(steamId);
    const rows = await this.prisma.tournamentTeamMember.findMany({
      where: { userId: user.id },
      include: { tournamentTeam: { select: { name: true, placement: true, seed: true } }, tournament: { select: { id: true, name: true, status: true, mode: true, format: true, startsAt: true, finishedAt: true } } },
      orderBy: { tournament: { startsAt: 'desc' } },
    });
    return {
      tournaments: rows.map((r) => ({ ...r.tournament, team: r.tournamentTeam.name, placement: r.tournamentTeam.placement, seed: r.tournamentTeam.seed })),
    };
  }

  private toHistoryRow(row: HistoryRow) {
    const mine = row.matchTeam!; // history only lists players who were on a team
    const other = row.match.teams.find((t) => t.slot !== mine.slot);
    const own = row.match.teams.find((t) => t.slot === mine.slot)!;
    const played = row.match.maps.filter((m) => m.status === 'FINISHED');
    const stats = deriveStats({ kills: row.kills, deaths: row.deaths, damage: row.damage, rounds: row.rounds, headshots: row.headshots });
    return {
      matchId: row.matchId,
      date: row.finishedAt,
      mode: row.mode,
      kind: row.match.kind,
      map: played.length === 1 ? played[0]!.map.name : played.length > 1 ? `${played.length} maps` : null,
      maps: played.map((m) => ({ name: m.map.name, scoreA: m.scoreA, scoreB: m.scoreB })),
      team: own.name,
      opponent: other?.name ?? null,
      score: { own: own.seriesScore, opponent: other?.seriesScore ?? 0 },
      result: row.won === true ? 'WIN' : row.won === false ? 'LOSS' : 'DRAW',
      kills: row.kills,
      deaths: row.deaths,
      assists: row.assists,
      headshots: row.headshots,
      kd: stats.kd,
      adr: stats.adr,
      hsPercent: stats.hsPercent,
      mvps: row.mvps,
      eloDelta: row.eloDelta,
      tournament: row.match.tournamentMatch?.tournament ?? null,
    };
  }
}

const matchInclude = {
  matchTeam: { select: { slot: true } },
  match: {
    include: {
      teams: { select: { slot: true, name: true, seriesScore: true } },
      maps: { include: { map: { select: { name: true } } }, orderBy: { mapNumber: 'asc' as const } },
      tournamentMatch: { select: { tournament: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.MatchPlayerInclude;

type HistoryRow = Prisma.MatchPlayerGetPayload<{ include: typeof matchInclude }>;
