import { Injectable } from '@nestjs/common';
import type { Prisma } from '@celtist/database';
import {
  deriveStats,
  displayMatchStatus,
  type MatchListQuery,
  type TeamSlot,
} from '@celtist/shared';
import { notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RankTiersService } from '../ranking/rank-tiers.service.js';

const LIVE_STATUSES = ['LOBBY', 'VETO', 'CONFIGURING', 'LIVE', 'SERVER_ERROR'] as const;

const detailInclude = {
  teams: {
    include: {
      players: { include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } }, orderBy: { isSubstitute: 'asc' } },
    },
  },
  maps: { include: { map: true }, orderBy: { mapNumber: 'asc' } },
  server: { select: { id: true, name: true, ip: true, port: true, region: true } },
  tournamentMatch: { include: { tournament: { select: { id: true, name: true } } } },
  controller: { select: { id: true, displayName: true } },
  // Players in the lobby that are not on a team yet.
  players: { where: { matchTeamId: null, removedAt: null }, include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } } },
} satisfies Prisma.MatchInclude;

type MatchDetail = Prisma.MatchGetPayload<{ include: typeof detailInclude }>;

export interface MatchViewer {
  userId: string;
  canSeeServer: boolean;
  /** Holds the admin permission `match.control`. */
  isAdmin: boolean;
}

@Injectable()
export class MatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiers: RankTiersService,
  ) {}

  async list(query: MatchListQuery) {
    const where: Prisma.MatchWhereInput = {
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.tournamentId ? { tournamentMatch: { tournamentId: query.tournamentId } } : {}),
      ...(query.steamId ? { players: { some: { steamId: query.steamId } } } : {}),
      ...(query.status === 'live' ? { status: { in: [...LIVE_STATUSES] } } : {}),
      ...(query.status === 'upcoming' ? { status: { in: ['SCHEDULED', 'WAITING'] } } : {}),
      ...(query.status === 'finished' ? { status: { in: ['FINISHED', 'CANCELLED'] } } : {}),
      // Byes have no match row, and matches without teams are bracket placeholders: not worth listing.
      NOT: { teams: { none: {} } },
    };
    const orderBy: Prisma.MatchOrderByWithRelationInput[] =
      query.status === 'finished' ? [{ finishedAt: 'desc' }] : query.status === 'live' ? [{ startedAt: 'desc' }] : [{ scheduledAt: 'asc' }, { createdAt: 'desc' }];

    const [total, rows] = await Promise.all([
      this.prisma.match.count({ where }),
      this.prisma.match.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          teams: { select: { slot: true, name: true, seriesScore: true, teamId: true } },
          maps: { include: { map: { select: { name: true, key: true } } }, orderBy: { mapNumber: 'asc' } },
          tournamentMatch: { select: { label: true, tournament: { select: { id: true, name: true } } } },
        },
      }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      matches: rows.map((m) => ({
        id: m.id,
        kind: m.kind,
        mode: m.mode,
        status: m.status,
        displayStatus: displayMatchStatus(m.status),
        bestOf: m.bestOf,
        scheduledAt: m.scheduledAt,
        startedAt: m.startedAt,
        finishedAt: m.finishedAt,
        winnerSlot: m.winnerSlot,
        tournament: m.tournamentMatch?.tournament ?? null,
        round: m.tournamentMatch?.label ?? null,
        teams: Object.fromEntries(m.teams.map((t) => [t.slot, { name: t.name, score: t.seriesScore, teamId: t.teamId }])),
        map: this.currentMap(m.maps),
      })),
    };
  }

  async get(matchId: string, viewer?: MatchViewer) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, include: detailInclude });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    return this.toView(match, viewer);
  }

  /** Per-player statistics: per map and for the whole series. */
  async scoreboard(matchId: string) {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        teams: { select: { slot: true, name: true, seriesScore: true } },
        maps: { include: { map: { select: { name: true, key: true } }, stats: { include: { matchPlayer: { select: { userId: true } } } } }, orderBy: { mapNumber: 'asc' } },
        players: { where: { matchTeamId: { not: null } }, include: { user: { select: { displayName: true, avatarUrl: true, steamId: true } }, matchTeam: { select: { slot: true } } } },
      },
    });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    const tiers = await this.tiers.tiers();
    const ranks = await this.prisma.playerRank.findMany({ where: { userId: { in: match.players.map((p) => p.userId) }, mode: match.mode } });
    const eloOf = new Map(ranks.map((r) => [r.userId, r.elo] as const));

    const row = (p: (typeof match.players)[number], stats: { kills: number; deaths: number; assists: number; headshots: number; damage: number; rounds: number; mvps: number }) => ({
      userId: p.userId,
      steamId: p.user.steamId,
      displayName: p.user.displayName,
      avatarUrl: p.user.avatarUrl,
      team: p.matchTeam!.slot,
      isSubstitute: p.isSubstitute,
      ...stats,
      ...deriveStats({ kills: stats.kills, deaths: stats.deaths, damage: stats.damage, rounds: stats.rounds, headshots: stats.headshots }),
      eloDelta: p.eloDelta,
      rank: eloOf.has(p.userId) ? tiers.filter((t) => t.minElo <= eloOf.get(p.userId)!).at(-1)?.name ?? null : null,
    });

    return {
      matchId: match.id,
      status: match.status,
      teams: match.teams,
      total: match.players
        .filter((p) => p.rounds > 0)
        .map((p) => row(p, p))
        .sort((a, b) => b.kills - a.kills),
      maps: match.maps.map((m) => ({
        mapNumber: m.mapNumber,
        map: m.map,
        status: m.status,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        winnerSlot: m.winnerSlot,
        players: m.stats
          .map((s) => {
            const player = match.players.find((p) => p.userId === s.matchPlayer.userId)!;
            return row(player, s);
          })
          .sort((a, b) => b.kills - a.kills),
      })),
    };
  }

  // ─────────────── view building ───────────────

  private async toView(match: MatchDetail, viewer?: MatchViewer) {
    const tiers = await this.tiers.tiers();
    const assigned = match.teams.flatMap((t) => t.players.filter((p) => p.removedAt === null));
    const userIds = [...match.teams.flatMap((t) => t.players.map((p) => p.userId)), ...match.players.map((p) => p.userId)];
    const ranks = await this.prisma.playerRank.findMany({ where: { userId: { in: userIds }, mode: match.mode } });
    const eloOf = new Map(ranks.map((r) => [r.userId, r.elo] as const));

    // Only players assigned to a team may see the server address; everyone else gets ACCESS DENIED at the plugin anyway.
    const isParticipant = viewer ? assigned.some((p) => p.userId === viewer.userId) : false;
    const canControl = !!viewer && (viewer.isAdmin || match.controllerId === viewer.userId);
    const showServer =
      !!match.server && !!viewer && (isParticipant || canControl || viewer.canSeeServer) && ['LOBBY', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'LIVE', 'SERVER_ERROR'].includes(match.status);

    const playerView = (p: { userId: string; user: { steamId: string; displayName: string; avatarUrl: string | null }; isCaptain: boolean; isSubstitute: boolean; connectedAt: Date | null; removedAt: Date | null; eloDelta: number | null }) => {
      const elo = eloOf.get(p.userId) ?? null;
      const tier = elo === null ? null : tiers.filter((t) => t.minElo <= elo).at(-1) ?? null;
      return {
        userId: p.userId,
        steamId: p.user.steamId,
        displayName: p.user.displayName,
        avatarUrl: p.user.avatarUrl,
        isCaptain: p.isCaptain,
        isSubstitute: p.isSubstitute,
        connected: p.connectedAt !== null,
        removed: p.removedAt !== null,
        elo,
        rank: tier ? { key: tier.key, name: tier.name, color: tier.color } : null,
        eloDelta: p.eloDelta,
      };
    };
    const team = (slot: TeamSlot) => {
      const row = match.teams.find((t) => t.slot === slot);
      if (!row) return null;
      return {
        slot,
        name: row.name,
        teamId: row.teamId,
        tournamentTeamId: row.tournamentTeamId,
        averageElo: row.averageElo,
        seriesScore: row.seriesScore,
        maxPlayers: row.maxPlayers,
        players: row.players.map(playerView),
      };
    };

    return {
      id: match.id,
      kind: match.kind,
      mode: match.mode,
      status: match.status,
      displayStatus: displayMatchStatus(match.status),
      bestOf: match.bestOf,
      scheduledAt: match.scheduledAt,
      startedAt: match.startedAt,
      finishedAt: match.finishedAt,
      paused: match.pausedAt !== null,
      pausedByTeam: match.pausedByTeam,
      winnerSlot: match.winnerSlot,
      resultType: match.resultType,
      cancelReason: match.cancelReason,
      vetoDeadline: match.vetoDeadline,
      controller: match.controller,
      tournament: match.tournamentMatch ? { ...match.tournamentMatch.tournament, round: match.tournamentMatch.label, bracketKey: match.tournamentMatch.key } : null,
      teams: { A: team('A'), B: team('B') },
      unassigned: match.players.map(playerView),
      maps: match.maps.map((m) => ({
        mapNumber: m.mapNumber,
        map: { id: m.map.id, key: m.map.key, name: m.map.name, imageUrl: m.map.imageUrl },
        pickedBy: m.pickedBy,
        teamAStartSide: m.teamAStartSide,
        status: m.status,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        winnerSlot: m.winnerSlot,
      })),
      server: showServer ? { name: match.server!.name, region: match.server!.region, address: `${match.server!.ip}:${match.server!.port}`, connect: `steam://connect/${match.server!.ip}:${match.server!.port}` } : null,
      viewer: viewer
        ? {
            isParticipant,
            canControl,
            role: viewer.isAdmin ? 'ADMIN' : match.controllerId === viewer.userId ? 'PARTY_LEADER' : null,
            slot: match.teams.find((t) => t.players.some((p) => p.userId === viewer.userId && p.removedAt === null))?.slot ?? null,
          }
        : null,
    };
  }

  private currentMap(maps: Array<{ status: string; scoreA: number; scoreB: number; mapNumber: number; map: { name: string; key: string } }>) {
    const live = maps.find((m) => m.status === 'LIVE') ?? maps.find((m) => m.status === 'PENDING') ?? maps.at(-1);
    return live ? { number: live.mapNumber, name: live.map.name, key: live.map.key, scoreA: live.scoreA, scoreB: live.scoreB } : null;
  }
}
