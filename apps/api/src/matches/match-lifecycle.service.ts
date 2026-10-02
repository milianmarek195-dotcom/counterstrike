import { randomInt } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, isUniqueViolation, type MatchStatus, type TransactionClient } from '@celtist/database';
import {
  MATCH_SETUP_STATUSES,
  buildDefaultVetoSteps,
  pickStartingTeam,
  validateVetoSteps,
  type BestOf,
  type VetoTemplateStep,
} from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { conflict, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { ServerAllocator } from '../servers/server-allocator.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchConfigService } from './match-config.service.js';

class RollbackAllocation extends Error {}

/**
 * Drives a match through its lifecycle. There is no ready check: a controller (party leader or admin) steers the
 * match from the website. Tournament matches are the exception that proves the rule: they continue automatically
 * into the map veto once a server is reserved, because no single person owns them.
 *
 * Every status change is a compare-and-set (`updateMany … where status = expected`), so concurrent callers (job tick,
 * controller click, automation) cannot both succeed and a match can never skip a state.
 */
@Injectable()
export class MatchLifecycleService {
  private readonly logger = new Logger(MatchLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly allocator: ServerAllocator,
    private readonly commands: MatchCommandService,
    private readonly config: MatchConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** SCHEDULED → WAITING once both teams exist; then immediately tries to find a server. */
  async markWaiting(matchId: string): Promise<boolean> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, include: { teams: { select: { slot: true } } } });
    if (!match || match.teams.length < 2) return false;
    const moved = await this.cas(matchId, 'SCHEDULED', 'WAITING');
    if (!moved) return match.status === 'WAITING';
    this.emitUpdated(matchId);
    await this.tryAllocate(matchId);
    return true;
  }

  /** WAITING → LOBBY: reserve a server and open the lobby. False if no server is free (retried by the tick). */
  async tryAllocate(matchId: string): Promise<boolean> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { tournamentMatch: { include: { tournament: { select: { status: true, servers: { select: { serverId: true } } } } } } },
    });
    if (!match || match.status !== 'WAITING') return false;
    const tournament = match.tournamentMatch?.tournament;
    if (tournament && tournament.status !== 'RUNNING') return false; // paused or not started: no new servers
    if (match.scheduledAt && match.scheduledAt.getTime() > this.clock.nowMs()) return false;

    const allocated = await this.prisma.transact(async (tx) => {
      // Lock the match row first (same order as finalisation), then pick the server.
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT "status" FROM "matches" WHERE "id" = ${matchId}::uuid FOR UPDATE`);
      if (!locked || locked.status !== 'WAITING') throw new RollbackAllocation();
      const server = await this.allocator.reserve(matchId, { allowedServerIds: tournament?.servers.map((s) => s.serverId) }, tx);
      if (!server) return null;
      // Maps already decided (forced before a server was free): the lobby opens in MAP_FORCED.
      const next = (await tx.matchMap.count({ where: { matchId } })) >= match.bestOf ? 'MAP_FORCED' : 'LOBBY';
      const moved = await tx.match.updateMany({ where: { id: matchId, status: 'WAITING' }, data: { status: next, serverId: server.id } });
      if (moved.count === 0) throw new RollbackAllocation();
      return server;
    }).catch((error) => {
      // Lost a race against another allocation of the same match: that one wins, nothing to do here.
      if (error instanceof RollbackAllocation || isUniqueViolation(error)) return null;
      throw error;
    });
    if (!allocated) return false;

    const config = await this.config.build(matchId);
    await this.commands.issue({ serverId: allocated.id, matchId, type: 'MATCH_PREPARE', payload: { config }, idempotencyKey: `prepare:${matchId}:${allocated.id}` });
    this.logger.log(`Match ${matchId} reserved server ${allocated.name}`);
    this.emitUpdated(matchId);

    if (match.kind === 'TOURNAMENT') await this.startVeto(matchId).catch((error: Error) => this.logger.warn(`Auto veto not started: ${error.message}`));
    return true;
  }

  /** Called by the job tick: gives waiting matches a chance to get a server. */
  async allocatePending(limit = 25): Promise<number> {
    const waiting = await this.prisma.match.findMany({
      where: { status: 'WAITING', OR: [{ scheduledAt: null }, { scheduledAt: { lte: this.clock.now() } }] },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true },
    });
    let allocated = 0;
    for (const { id } of waiting) if (await this.tryAllocate(id)) allocated++;
    return allocated;
  }

  // ─────────────── map decision: veto or force ───────────────

  /** LOBBY / MAP_FORCED → VETO. Needs at least one player on each team. */
  async startVeto(matchId: string): Promise<boolean> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { vetoTemplate: true, mapPool: { include: { maps: { include: { map: true }, orderBy: { position: 'asc' } } } } },
    });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (match.status !== 'LOBBY' && match.status !== 'MAP_FORCED') throw conflict('INVALID_MATCH_STATE', `The veto cannot start while the match is ${match.status}`);
    await this.assertBothTeamsHavePlayers(matchId);

    const mapIds = (match.mapPool?.maps ?? []).filter((m) => m.map.active).map((m) => m.mapId);
    if (mapIds.length < match.bestOf) throw conflict('MAP_POOL_TOO_SMALL', `The map pool has too few maps for a best-of-${match.bestOf}`);

    const steps = this.stepsFor(match.bestOf as BestOf, mapIds.length, match.vetoTemplate?.steps as VetoTemplateStep[] | undefined);
    const stepTimeout = await this.settings.get('veto.stepTimeoutSeconds');
    const startsWith = pickStartingTeam(() => randomInt(0, 1_000_000) / 1_000_000);
    const moved = await this.prisma.transact(async (tx) => {
      const claimed = await tx.match.updateMany({
        where: { id: matchId, status: { in: ['LOBBY', 'MAP_FORCED'] } },
        data: { status: 'VETO', vetoStartsWith: startsWith, vetoConfig: { maps: mapIds, steps } as never, vetoDeadline: new Date(this.clock.nowMs() + stepTimeout * 1000) },
      });
      if (claimed.count === 0) return false;
      await tx.matchVetoAction.deleteMany({ where: { matchId } });
      await tx.matchMap.deleteMany({ where: { matchId, status: 'PENDING' } }); // an earlier forced map is replaced by the veto
      return true;
    });
    if (!moved) return false;
    this.emitUpdated(matchId);
    this.events.emit(DomainEvent.MatchVeto, { matchId } satisfies MatchEventPayload);
    return true;
  }

  /**
   * A controller forces the map for one map slot. Overrides any running or planned veto (state MAP_FORCED). Validated
   * here, never in the client: the map must belong to the match's pool and the match must still be in setup.
   * Returns the previous map (for the audit log).
   */
  async forceMap(matchId: string, mapNumber: number, mapId: string): Promise<{ oldMap: string | null; newMap: string }> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: { mapPool: { include: { maps: { select: { mapId: true } } } }, maps: { include: { map: true } } },
    });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (!(MATCH_SETUP_STATUSES as readonly string[]).includes(match.status)) {
      throw conflict('MAP_LOCKED', `The map cannot be forced while the match is ${match.status}; use restart/change map for running matches`);
    }
    if (mapNumber > match.bestOf) throw conflict('INVALID_MAP_NUMBER', `A best-of-${match.bestOf} has ${match.bestOf} map slot(s)`);
    if (!match.mapPool?.maps.some((m) => m.mapId === mapId)) throw conflict('MAP_NOT_IN_POOL', 'That map is not part of the match map pool');
    const map = await this.prisma.gameMap.findUnique({ where: { id: mapId } });
    if (!map || !map.active) throw conflict('MAP_NOT_AVAILABLE', 'That map is not available');
    if (match.maps.some((m) => m.mapId === mapId && m.mapNumber !== mapNumber)) throw conflict('MAP_ALREADY_USED', 'That map is already used for another slot');

    const old = match.maps.find((m) => m.mapNumber === mapNumber);
    await this.prisma.transact(async (tx) => {
      const claimed = await tx.match.updateMany({
        where: { id: matchId, status: { in: [...MATCH_SETUP_STATUSES] as MatchStatus[] } },
        // Without a server the match keeps waiting for one (the forced map is remembered); with one it becomes MAP_FORCED.
        data: { status: match.serverId ? 'MAP_FORCED' : match.status, vetoDeadline: null, vetoConfig: Prisma.DbNull, vetoStartsWith: null },
      });
      if (claimed.count === 0) throw conflict('STATE_CHANGED', 'The match state changed, try again');
      await tx.matchVetoAction.deleteMany({ where: { matchId } }); // forcing overrides the veto
      if (old) await tx.matchMap.update({ where: { id: old.id }, data: { mapId, pickedBy: null } });
      else {
        await tx.matchMap.create({ data: { matchId, mapNumber, mapId, teamAStartSide: randomInt(0, 2) === 0 ? 'CT' : 'T' } });
      }
    });
    this.emitUpdated(matchId);
    return { oldMap: old?.map.name ?? null, newMap: map.name };
  }

  /** The explicit "START MATCH": LOBBY/MAP_FORCED → CONFIGURING. Needs a server, a full set of maps and players on both sides. */
  async startMatch(matchId: string): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, include: { maps: true } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (match.status !== 'LOBBY' && match.status !== 'MAP_FORCED') throw conflict('INVALID_MATCH_STATE', `The match cannot be started while it is ${match.status}`);
    if (!match.serverId) throw conflict('NO_SERVER', 'Assign a server first');
    await this.assertBothTeamsHavePlayers(matchId);
    if (match.maps.length < match.bestOf) {
      throw conflict('MAPS_INCOMPLETE', `A best-of-${match.bestOf} needs ${match.bestOf} map(s): force the missing maps or run the veto`);
    }
    if (!(await this.cas(matchId, match.status, 'CONFIGURING'))) throw conflict('STATE_CHANGED', 'The match state changed, try again');
    const config = await this.config.build(matchId);
    await this.commands.issue({ serverId: match.serverId, matchId, type: 'MATCH_START', payload: { config }, idempotencyKey: `start:${matchId}` });
    this.emitUpdated(matchId);
  }

  private async assertBothTeamsHavePlayers(matchId: string): Promise<void> {
    const players = await this.prisma.matchPlayer.findMany({
      where: { matchId, removedAt: null, matchTeamId: { not: null } },
      select: { matchTeam: { select: { slot: true } } },
    });
    const slots = new Set(players.map((p) => p.matchTeam!.slot));
    if (!slots.has('A') || !slots.has('B')) throw conflict('TEAMS_EMPTY', 'Both teams need at least one player');
  }

  /** A configured template is used only if it fits the pool; otherwise the default order for the pool size applies. */
  private stepsFor(bestOf: BestOf, mapCount: number, template?: VetoTemplateStep[]): VetoTemplateStep[] {
    if (template && validateVetoSteps(template, bestOf, mapCount).length === 0) return template;
    if (template) this.logger.warn(`Veto template does not fit a pool of ${mapCount} maps; using the default order`);
    return buildDefaultVetoSteps(bestOf, mapCount);
  }

  // ─────────────── cancellation and errors ───────────────

  async cancel(matchId: string, reason: string, tx?: TransactionClient): Promise<boolean> {
    const run = async (db: TransactionClient): Promise<boolean> => {
      const match = await db.match.findUnique({ where: { id: matchId }, select: { status: true, serverId: true } });
      if (!match || match.status === 'FINISHED' || match.status === 'CANCELLED') return false;
      const moved = await db.match.updateMany({
        where: { id: matchId, status: match.status },
        data: { status: 'CANCELLED', cancelReason: reason, finishedAt: this.clock.now(), vetoDeadline: null },
      });
      if (moved.count === 0) return false;
      if (match.serverId) {
        await this.commands.issue({ serverId: match.serverId, matchId, type: 'MATCH_CANCEL', payload: { matchId, reason }, idempotencyKey: `cancel:${matchId}` }, db);
      }
      await this.allocator.release(matchId, db);
      return true;
    };
    const done = tx ? await run(tx) : await this.prisma.transact(run);
    if (done) {
      this.events.emit(DomainEvent.MatchCancelled, { matchId } satisfies MatchEventPayload);
      this.emitUpdated(matchId);
    }
    return done;
  }

  /** The server vanished or lost the match. Before the match started the lobby simply starts over on another server. */
  async handleServerProblem(matchId: string, reason: string): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { status: true } });
    if (!match) return;
    if (match.status === 'LIVE' || match.status === 'CONFIGURING') {
      if (await this.cas(matchId, match.status, 'SERVER_ERROR')) {
        this.logger.warn(`Match ${matchId} → SERVER_ERROR (${reason})`);
        this.events.emit(DomainEvent.MatchServerError, { matchId, reason });
        this.emitUpdated(matchId);
      }
      return;
    }
    if (match.status === 'LOBBY' || match.status === 'VETO' || match.status === 'MAP_FORCED') await this.backToWaiting(matchId);
  }

  /** Releases the server and resets the lobby (connections, veto) so the match can be allocated again. Forced maps stay. */
  async backToWaiting(matchId: string): Promise<boolean> {
    const done = await this.prisma.transact(async (tx) => {
      const match = await tx.match.findUnique({ where: { id: matchId }, select: { status: true } });
      if (!match || !['LOBBY', 'VETO', 'MAP_FORCED'].includes(match.status)) return false;
      await tx.matchVetoAction.deleteMany({ where: { matchId } });
      await tx.matchPlayer.updateMany({ where: { matchId }, data: { connectedAt: null } });
      await tx.match.update({ where: { id: matchId }, data: { status: 'WAITING', serverId: null, vetoDeadline: null, vetoConfig: Prisma.DbNull, vetoStartsWith: null } });
      await this.allocator.release(matchId, tx);
      return true;
    });
    if (done) this.emitUpdated(matchId);
    return done;
  }

  /** Expired reservations (the match never got going): release the server and queue the match again. */
  async expireReservations(): Promise<number> {
    const expired = await this.allocator.findExpiredReservations();
    for (const { matchId } of expired) await this.backToWaiting(matchId);
    return expired.length;
  }

  // ─────────────── helpers ───────────────

  async cas(matchId: string, from: MatchStatus, to: MatchStatus): Promise<boolean> {
    const result = await this.prisma.match.updateMany({ where: { id: matchId, status: from }, data: { status: to } });
    return result.count === 1;
  }

  emitUpdated(matchId: string): void {
    this.events.emit(DomainEvent.MatchUpdated, { matchId } satisfies MatchEventPayload);
  }
}
