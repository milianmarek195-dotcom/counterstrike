import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '@celtist/database';
import type { ServerEventPayload } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { PrismaService } from '../database/prisma.service.js';
import { ServerAllocator } from '../servers/server-allocator.service.js';
import { MatchFinalizerService } from './match-finalizer.service.js';
import { MatchLifecycleService } from './match-lifecycle.service.js';

/** Applies what a game server reports (player joined, round ended, pause …) to the match. */
@Injectable()
export class ServerEventsService {
  private readonly logger = new Logger(ServerEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly allocator: ServerAllocator,
    private readonly lifecycle: MatchLifecycleService,
    private readonly events: EventEmitter2,
  ) {}

  /** Stores each event once (idempotency key) and applies its effect. Returns how many were new. */
  async ingest(serverId: string, batch: readonly ServerEventPayload[]): Promise<{ accepted: number; duplicates: number }> {
    let accepted = 0;
    let duplicates = 0;
    for (const event of [...batch].sort((a, b) => a.seq - b.seq)) {
      try {
        await this.prisma.serverEvent.create({
          data: {
            serverId,
            matchId: event.matchId,
            type: event.type,
            seq: event.seq,
            idempotencyKey: event.idempotencyKey,
            payload: event as never,
            serverTimestamp: new Date(event.at),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          duplicates++;
          continue;
        }
        throw error;
      }
      accepted++;
      try {
        await this.apply(serverId, event);
      } catch (error) {
        this.logger.error(`Could not apply ${event.type} from ${serverId}: ${(error as Error).message}`);
      }
    }
    return { accepted, duplicates };
  }

  private async apply(serverId: string, event: ServerEventPayload): Promise<void> {
    if (event.type === 'server.error') {
      this.logger.warn(`Server ${serverId} reported an error: ${event.message}`);
      if (event.matchId) await this.guardedMatch(serverId, event.matchId, () => this.lifecycle.handleServerProblem(event.matchId!, event.message));
      return;
    }
    if (!event.matchId) return;
    const matchId = event.matchId;
    await this.guardedMatch(serverId, matchId, async () => {
      switch (event.type) {
        case 'player.connected':
          await this.prisma.matchPlayer.updateMany({ where: { matchId, steamId: event.steamId, removedAt: null }, data: { connectedAt: new Date(event.at) } });
          this.emitUpdated(matchId);
          break;
        case 'player.disconnected':
          this.emitUpdated(matchId);
          break;
        case 'player.rejected':
          this.logger.log(`Server rejected ${event.steamId} for match ${matchId}: ${event.reason}`);
          break;
        case 'map.started':
          await this.mapStarted(serverId, matchId, event.mapNumber, new Date(event.at));
          break;
        case 'round.ended':
          await this.roundEnded(matchId, event.mapNumber, event.scoreA, event.scoreB);
          break;
        case 'match.paused':
          await this.prisma.match.updateMany({ where: { id: matchId, status: { in: ['LIVE', 'SERVER_ERROR'] } }, data: { pausedAt: new Date(event.at), pausedByTeam: event.team } });
          this.emitUpdated(matchId);
          break;
        case 'match.unpaused':
          await this.prisma.match.updateMany({ where: { id: matchId }, data: { pausedAt: null, pausedByTeam: null } });
          this.emitUpdated(matchId);
          break;
        case 'penalty.team_damage':
          await this.teamDamagePenalty(matchId, event.steamId, event.reason);
          break;
        case 'match.configured':
          break;
      }
    });
  }

  /** Events only count when they come from the server that actually hosts the match. */
  private async guardedMatch(serverId: string, matchId: string, run: () => Promise<void>): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { serverId: true } });
    if (!match || match.serverId !== serverId) {
      this.logger.warn(`Ignoring event for match ${matchId} from server ${serverId}: not its host`);
      return;
    }
    await run();
  }

  private async mapStarted(serverId: string, matchId: string, mapNumber: number, at: Date): Promise<void> {
    const updated = await this.prisma.matchMap.updateMany({
      where: { matchId, mapNumber, status: 'PENDING' },
      data: { status: 'LIVE', startedAt: at },
    });
    if (updated.count === 0) return;
    const wentLive = await this.prisma.match.updateMany({
      where: { id: matchId, status: { in: ['CONFIGURING', 'SERVER_ERROR'] } },
      data: { status: 'LIVE', startedAt: at },
    });
    await this.prisma.match.updateMany({ where: { id: matchId, startedAt: null }, data: { startedAt: at } });
    if (wentLive.count > 0) {
      await this.allocator.pinReservation(matchId);
      this.events.emit(DomainEvent.MatchStarted, { matchId } satisfies MatchEventPayload);
    }
    this.emitUpdated(matchId);
  }

  private async roundEnded(matchId: string, mapNumber: number, scoreA: number, scoreB: number): Promise<void> {
    // Scores only move forward: a delayed or replayed event can never roll the live score back.
    const updated = await this.prisma.matchMap.updateMany({
      where: { matchId, mapNumber, status: { in: ['PENDING', 'LIVE'] }, scoreA: { lte: scoreA }, scoreB: { lte: scoreB } },
      data: { status: 'LIVE', scoreA, scoreB },
    });
    if (updated.count > 0) this.events.emit(DomainEvent.MatchScore, { matchId } satisfies MatchEventPayload);
  }

  private async teamDamagePenalty(matchId: string, steamId: string, reason: string): Promise<void> {
    const player = await this.prisma.matchPlayer.findFirst({ where: { matchId, steamId } });
    if (!player) return;
    const existing = await this.prisma.ban.findFirst({ where: { userId: player.userId, matchId, type: 'MATCH', revokedAt: null } });
    if (!existing) await this.prisma.ban.create({ data: { userId: player.userId, matchId, type: 'MATCH', reason: reason.slice(0, 200) } });
    await this.prisma.matchPlayer.update({ where: { id: player.id }, data: { removedAt: this.clock.now(), removalReason: 'TEAM_DAMAGE' } });
    this.emitUpdated(matchId);
  }

  private emitUpdated(matchId: string): void {
    this.events.emit(DomainEvent.MatchUpdated, { matchId } satisfies MatchEventPayload);
  }
}

/** Reacts to domain events from other modules (kept separate from the services so they stay free of cycles). */
@Injectable()
export class MatchAutomationListener {
  private readonly logger = new Logger(MatchAutomationListener.name);

  constructor(
    private readonly lifecycle: MatchLifecycleService,
    private readonly finalizer: MatchFinalizerService,
  ) {}

  @OnEvent(DomainEvent.MatchReadyToSchedule, { suppressErrors: false })
  async onReady(payload: MatchEventPayload): Promise<void> {
    await this.safely(() => this.lifecycle.markWaiting(payload.matchId), 'schedule');
  }

  @OnEvent(DomainEvent.ServerOffline)
  async onServerOffline(payload: { serverId: string; matchId: string | null }): Promise<void> {
    if (payload.matchId) await this.safely(() => this.lifecycle.handleServerProblem(payload.matchId!, 'SERVER_OFFLINE'), 'server offline');
  }

  @OnEvent(DomainEvent.ServerMatchLost)
  async onMatchLost(payload: { serverId: string; matchId: string }): Promise<void> {
    await this.safely(() => this.lifecycle.handleServerProblem(payload.matchId, 'SERVER_LOST_MATCH'), 'match lost');
  }

  @OnEvent(DomainEvent.MatchForfeitRequested)
  async onForfeit(payload: { matchId: string; winner: 'A' | 'B'; reason: string }): Promise<void> {
    await this.safely(() => this.finalizer.forfeit(payload.matchId, payload.winner, payload.reason), 'forfeit');
  }

  private async safely(run: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(`Automation (${what}) failed: ${(error as Error).message}`);
    }
  }
}
