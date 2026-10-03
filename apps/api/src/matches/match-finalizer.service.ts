import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation, type TransactionClient } from '@celtist/database';
import {
  SIGNATURE_MAX_SKEW_MS,
  mapsToWin,
  roundsToWin,
  seriesState,
  sumCombatStats,
  type BestOf,
  type CombatStats,
  type EloOutcome,
  type MapResultPayload,
  type TeamSlot,
  validateMapResult,
} from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { AppException, conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { ServerAllocator } from '../servers/server-allocator.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BracketProgressionService, type ProgressionOutcome } from '../tournaments/bracket-progression.service.js';
import { MatchCommandService } from './match-commands.service.js';

export interface MapResultOutcome {
  status: 'MAP_ACCEPTED' | 'MATCH_FINISHED';
  /** True when this exact report had been processed before (retry after a lost response). */
  duplicate: boolean;
  nextMapNumber: number | null;
}

class DuplicateResult extends Error {}

const ACCEPTING_STATUSES = ['CONFIGURING', 'LIVE', 'SERVER_ERROR'] as const;

/**
 * Turns a game server's report into the permanent record. Everything that must happen together happens in one
 * database transaction: map result, player stats, series result, Elo, career stats, bracket progression and the
 * release of the server. Either all of it is visible or none of it – and processing the same report twice is a no-op.
 */
@Injectable()
export class MatchFinalizerService {
  private readonly logger = new Logger(MatchFinalizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly ranking: RankingService,
    private readonly progression: BracketProgressionService,
    private readonly allocator: ServerAllocator,
    private readonly commands: MatchCommandService,
    private readonly events: EventEmitter2,
  ) {}

  async acceptMapResult(serverId: string, payload: MapResultPayload): Promise<MapResultOutcome> {
    const match = await this.prisma.match.findUnique({
      where: { id: payload.matchId },
      include: { teams: { include: { players: true } }, maps: { orderBy: { mapNumber: 'asc' } }, tournamentMatch: true },
    });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (match.serverId !== serverId) throw forbidden('This match is not hosted on your server', 'NOT_YOUR_MATCH');

    // Retried delivery of a report we already processed: answer as before.
    if (match.finalizedKey === payload.idempotencyKey || match.maps.some((m) => m.resultKey === payload.idempotencyKey)) {
      return this.duplicateOutcome(payload.matchId);
    }
    if (!(ACCEPTING_STATUSES as readonly string[]).includes(match.status)) {
      throw conflict('MATCH_CLOSED', `The match is ${match.status} and no longer accepts results`);
    }

    const current = match.maps.find((m) => m.status !== 'FINISHED' && m.status !== 'SKIPPED');
    if (!current) throw conflict('NO_OPEN_MAP', 'All maps of this match already have a result');

    const roster = match.teams.flatMap((t) => t.players.map((p) => ({ steamId: p.steamId, team: t.slot })));
    // The plugin restarts its own clock after a restart in the middle of a map; the backend knows when the match really started.
    const reportedStart = match.startedAt && match.startedAt.getTime() < payload.startedAt.getTime() ? { ...payload, startedAt: match.startedAt } : payload;
    const validation = validateMapResult(
      {
        matchId: match.id,
        expectedMapNumber: current.mapNumber,
        roster,
        roundsToWin: roundsToWin(match.mode),
        allowDraw: match.kind !== 'TOURNAMENT' && match.bestOf === 1,
        nowMs: this.clock.nowMs(),
        maxClockSkewMs: SIGNATURE_MAX_SKEW_MS,
      },
      reportedStart,
    );
    if (!validation.ok) {
      this.logger.warn(`Rejected result for match ${match.id}: ${validation.errors.join('; ')}`);
      throw unprocessable('RESULT_REJECTED', 'The result does not match the match data', validation.errors);
    }
    if (validation.anomalies.length > 0) this.logger.warn(`Result anomalies for match ${match.id}: ${validation.anomalies.join('; ')}`);

    const priorWinners = match.maps.filter((m) => m.status === 'FINISHED').map((m) => m.winnerSlot);
    const series = seriesState(match.bestOf as BestOf, [...priorWinners, validation.winner]);

    let outcome: ProgressionOutcome | null = null;
    let finished = false;
    try {
      await this.prisma.transact(async (tx) => {
        const recorded = await tx.matchMap.updateMany({
          where: { id: current.id, resultKey: null, status: { in: ['PENDING', 'LIVE'] } },
          data: {
            status: 'FINISHED',
            scoreA: payload.scoreA,
            scoreB: payload.scoreB,
            rounds: payload.rounds,
            winnerSlot: validation.winner,
            resultKey: payload.idempotencyKey,
            startedAt: payload.startedAt,
            finishedAt: payload.endedAt,
          },
        });
        if (recorded.count === 0) throw new DuplicateResult();

        const players = await tx.matchPlayer.findMany({ where: { matchId: match.id } });
        const bySteamId = new Map(players.map((p) => [p.steamId, p] as const));
        await tx.matchPlayerMapStats.createMany({
          data: payload.players.map((p) => ({
            matchMapId: current.id,
            matchPlayerId: bySteamId.get(p.steamId)!.id,
            rounds: p.rounds,
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            headshots: p.headshots,
            damage: p.damage,
            mvps: p.mvps,
            flashAssists: p.flashAssists,
            utilityDamage: p.utilityDamage,
            clutches: p.clutches,
            entryKills: p.entryKills,
            entryDeaths: p.entryDeaths,
            killsAwp: p.killsAwp,
            killsAk47: p.killsAk47,
            killsPistol: p.killsPistol,
          })),
        });

        const teamA = match.teams.find((t) => t.slot === 'A')!;
        const teamB = match.teams.find((t) => t.slot === 'B')!;
        await tx.matchTeam.update({ where: { id: teamA.id }, data: { seriesScore: series.winsA } });
        await tx.matchTeam.update({ where: { id: teamB.id }, data: { seriesScore: series.winsB } });

        if (series.nextMapNumber !== null) {
          await tx.match.updateMany({ where: { id: match.id, status: { in: ['CONFIGURING', 'SERVER_ERROR'] } }, data: { status: 'LIVE' } });
          return;
        }
        finished = true;
        outcome = await this.finishSeries(tx, match.id, match.mode, match.kind, series.winner, 'NORMAL', payload.idempotencyKey, match.tournamentMatch?.id ?? null);
      });
    } catch (error) {
      if (error instanceof DuplicateResult || isUniqueViolation(error)) return this.duplicateOutcome(match.id);
      throw error;
    }

    this.announce(match.id, match.tournamentMatch?.tournamentId ?? null, finished, outcome);
    return { status: finished ? 'MATCH_FINISHED' : 'MAP_ACCEPTED', duplicate: false, nextMapNumber: series.nextMapNumber };
  }

  /** One team forfeits (no-show, surrender). Elo is only applied when `elo.rateForfeits` is on. */
  async forfeit(matchId: string, winner: TeamSlot, reason: string): Promise<boolean> {
    return this.finishWithoutResult(matchId, winner, 'FORFEIT', reason);
  }

  /** Administrative decision (dispute, technical failure): the bracket advances, ratings do not change. */
  async decide(matchId: string, winner: TeamSlot, reason: string): Promise<boolean> {
    return this.finishWithoutResult(matchId, winner, 'ADMIN_DECISION', reason);
  }

  private async finishWithoutResult(matchId: string, winner: TeamSlot, type: 'FORFEIT' | 'ADMIN_DECISION', reason: string): Promise<boolean> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, include: { teams: true, tournamentMatch: true } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (match.status === 'FINISHED' || match.status === 'CANCELLED') return false;
    if (match.teams.length < 2) throw conflict('TEAMS_MISSING', 'Both teams must be known before a result can be set');

    let outcome: ProgressionOutcome | null = null;
    let done = false;
    try {
      await this.prisma.transact(async (tx) => {
      const needed = mapsToWin(match.bestOf as BestOf);
      for (const team of match.teams) {
        await tx.matchTeam.update({ where: { id: team.id }, data: { seriesScore: team.slot === winner ? needed : 0 } });
      }
      await tx.matchMap.updateMany({ where: { matchId, status: { in: ['PENDING', 'LIVE'] } }, data: { status: 'SKIPPED' } });
      const key = `${type.toLowerCase()}:${matchId}`;
      outcome = await this.finishSeries(tx, matchId, match.mode, match.kind, winner, type, key, match.tournamentMatch?.id ?? null, match.status, reason);
      done = true;
      });
    } catch (error) {
      if (error instanceof DuplicateResult) return false; // finished by someone else in the meantime
      throw error;
    }
    if (done) this.announce(matchId, match.tournamentMatch?.tournamentId ?? null, true, outcome);
    return done;
  }

  /** The common tail of every way a series can end. Runs inside the caller's transaction. */
  private async finishSeries(
    tx: TransactionClient,
    matchId: string,
    mode: 'FIVE_V_FIVE' | 'WINGMAN',
    kind: 'TOURNAMENT' | 'MATCHMAKING' | 'CUSTOM',
    winner: TeamSlot | null,
    resultType: 'NORMAL' | 'FORFEIT' | 'ADMIN_DECISION',
    finalizedKey: string,
    tournamentMatchId: string | null,
    fromStatus?: string,
    reason?: string,
  ): Promise<ProgressionOutcome | null> {
    const now = this.clock.now();
    const closed = await tx.match.updateMany({
      // Played results close a running match; forfeits and decisions may close it from any open state.
      where: { id: matchId, status: fromStatus ? { notIn: ['FINISHED', 'CANCELLED'] } : { in: [...ACCEPTING_STATUSES] } },
      data: { status: 'FINISHED', winnerSlot: winner, resultType, finalizedKey, finishedAt: now, pausedAt: null, pausedByTeam: null, vetoDeadline: null, cancelReason: reason ?? null },
    });
    if (closed.count === 0) throw new DuplicateResult();

    // Player totals for the series, summed from the per-map rows.
    const sums = await tx.matchPlayerMapStats.groupBy({
      by: ['matchPlayerId'],
      where: { matchPlayer: { matchId } },
      _sum: { rounds: true, kills: true, deaths: true, assists: true, headshots: true, damage: true, mvps: true, flashAssists: true, utilityDamage: true, clutches: true, entryKills: true, entryDeaths: true, killsAwp: true, killsAk47: true, killsPistol: true },
    });
    // Players without a team (lobby only) take no part in the result.
    const players = (await tx.matchPlayer.findMany({ where: { matchId, matchTeamId: { not: null } }, include: { matchTeam: { select: { slot: true } } } })).map((p) => ({ ...p, matchTeam: p.matchTeam! }));
    const totals = new Map(
      sums.map((s) => [
        s.matchPlayerId,
        {
          rounds: s._sum.rounds ?? 0,
          kills: s._sum.kills ?? 0,
          deaths: s._sum.deaths ?? 0,
          assists: s._sum.assists ?? 0,
          headshots: s._sum.headshots ?? 0,
          damage: s._sum.damage ?? 0,
          mvps: s._sum.mvps ?? 0,
          flashAssists: s._sum.flashAssists ?? 0,
          utilityDamage: s._sum.utilityDamage ?? 0,
          clutches: s._sum.clutches ?? 0,
          entryKills: s._sum.entryKills ?? 0,
          entryDeaths: s._sum.entryDeaths ?? 0,
          killsAwp: s._sum.killsAwp ?? 0,
          killsAk47: s._sum.killsAk47 ?? 0,
          killsPistol: s._sum.killsPistol ?? 0,
        } satisfies CombatStats,
      ] as const),
    );
    for (const player of players) {
      const stats = totals.get(player.id);
      await tx.matchPlayer.update({
        where: { id: player.id },
        data: { ...(stats ?? {}), won: stats ? (winner === null ? null : winner === player.matchTeam.slot) : null, finishedAt: now },
      });
    }

    const rated = this.isRated(kind, resultType, await this.settings.get('elo.rateForfeits'));
    if (rated) {
      const played = (slot: TeamSlot) =>
        players.filter((p) => p.matchTeam.slot === slot && (resultType === 'NORMAL' ? (totals.get(p.id)?.rounds ?? 0) > 0 : !p.isSubstitute && !p.removedAt));
      const teamA = played('A');
      const teamB = played('B');
      if (teamA.length > 0 && teamB.length > 0) {
        const outcomeForA: EloOutcome = winner === null ? 'DRAW' : winner === 'A' ? 'WIN' : 'LOSS';
        await this.ranking.applyMatchElo(tx, { matchId, mode, teamA: teamA.map((p) => ({ userId: p.userId })), teamB: teamB.map((p) => ({ userId: p.userId })), outcomeForA });
      } else {
        this.logger.warn(`Match ${matchId} finished without rated players on both sides: Elo not applied`);
      }
    }
    if (totals.size > 0) {
      await this.ranking.applyMatchStats(
        tx,
        mode,
        players.filter((p) => totals.has(p.id)).map((p) => ({ userId: p.userId, stats: sumCombatStats([totals.get(p.id)!]) })),
      );
    }

    let outcome: ProgressionOutcome | null = null;
    if (tournamentMatchId) {
      if (winner === null) throw unprocessable('NO_WINNER', 'A tournament match needs a winner');
      outcome = await this.progression.onMatchFinished(tx, tournamentMatchId, winner);
    }

    await this.allocator.release(matchId, tx);
    const match = await tx.match.findUniqueOrThrow({ where: { id: matchId }, select: { serverId: true } });
    if (match.serverId && resultType !== 'NORMAL') {
      await this.commands.issue({ serverId: match.serverId, matchId, type: 'MATCH_CANCEL', payload: { matchId, reason: resultType }, idempotencyKey: `end:${matchId}` }, tx);
    }
    return outcome;
  }

  private isRated(kind: 'TOURNAMENT' | 'MATCHMAKING' | 'CUSTOM', resultType: 'NORMAL' | 'FORFEIT' | 'ADMIN_DECISION', rateForfeits: boolean): boolean {
    if (kind === 'CUSTOM' || resultType === 'ADMIN_DECISION') return false;
    return resultType === 'NORMAL' || rateForfeits;
  }

  private announce(matchId: string, tournamentId: string | null, finished: boolean, outcome: ProgressionOutcome | null): void {
    const payload: MatchEventPayload = { matchId, tournamentId };
    this.events.emit(DomainEvent.MatchScore, payload);
    this.events.emit(DomainEvent.MatchUpdated, payload);
    if (!finished) return;
    this.events.emit(DomainEvent.MatchFinished, payload);
    this.events.emit(DomainEvent.RankingChanged, { matchId });
    if (tournamentId) {
      this.events.emit(DomainEvent.TournamentBracket, { tournamentId });
      if (outcome?.championTournamentTeamId) this.events.emit(DomainEvent.TournamentFinished, { tournamentId });
    }
    for (const readyId of outcome?.readyMatchIds ?? []) {
      this.events.emit(DomainEvent.MatchReadyToSchedule, { matchId: readyId, tournamentId } satisfies MatchEventPayload);
    }
  }

  private async duplicateOutcome(matchId: string): Promise<MapResultOutcome> {
    const match = await this.prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { maps: { orderBy: { mapNumber: 'asc' } } } });
    const next = match.maps.find((m) => m.status !== 'FINISHED' && m.status !== 'SKIPPED');
    const finished = match.status === 'FINISHED';
    return { status: finished ? 'MATCH_FINISHED' : 'MAP_ACCEPTED', duplicate: true, nextMapNumber: finished ? null : (next?.mapNumber ?? null) };
  }
}

export { AppException };

