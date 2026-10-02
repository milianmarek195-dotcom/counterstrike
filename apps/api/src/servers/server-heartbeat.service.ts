import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import type { ServerStatus } from '@celtist/database';
import { SERVER_OFFLINE_AFTER_MS, type HeartbeatPayload } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type ServerStatusPayload } from '../common/domain-events.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export interface HeartbeatResult {
  serverTime: number;
  pendingCommands: number;
  /** What the backend believes the server hosts; the plugin reconciles against it. */
  expectedMatchId: string | null;
  skinsEnabled: boolean;
}

/** Consecutive heartbeats that report a match the backend no longer knows before the backend orders a reset. */
const STALE_MATCH_BEATS = 6;

@Injectable()
export class ServerHeartbeatService {
  private readonly logger = new Logger(ServerHeartbeatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clock: Clock,
    private readonly events: EventEmitter2,
  ) {}

  async handle(serverId: string, payload: HeartbeatPayload): Promise<HeartbeatResult> {
    const now = this.clock.now();
    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: serverId } });
    const previous = server.status;

    const status = this.nextStatus(payload.status, server.currentMatchId !== null, server.maintenanceHold);
    await this.prisma.server.update({
      where: { id: serverId },
      data: {
        status,
        lastHeartbeatAt: now,
        playerCount: payload.players,
        pluginVersion: payload.version,
        gameVersion: payload.gameVersion ?? server.gameVersion,
        health: (payload.health ?? server.health ?? undefined) as never,
      },
    });

    if (status !== previous) {
      this.logger.log(`Server ${server.name} ${previous} → ${status}`);
      this.events.emit(DomainEvent.ServerStatus, { serverId, status, previousStatus: previous } satisfies ServerStatusPayload);
    }

    await this.reconcileMatch(serverId, server.currentMatchId, payload);

    const pendingCommands = await this.prisma.adminAction.count({
      where: { serverId, status: 'PENDING', expiresAt: { gt: now } },
    });
    return { serverTime: now.getTime(), pendingCommands, expectedMatchId: server.currentMatchId, skinsEnabled: server.skinsEnabled };
  }

  /**
   * Servers silent for longer than the heartbeat timeout become OFFLINE. Reads (server list) also compute this
   * on the fly, so the job only has to persist the transition and notify the match lifecycle.
   */
  async markStaleOffline(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - SERVER_OFFLINE_AFTER_MS);
    const stale = await this.prisma.server.findMany({
      where: { status: { not: 'OFFLINE' }, OR: [{ lastHeartbeatAt: { lt: cutoff } }, { lastHeartbeatAt: null }] },
      select: { id: true, name: true, status: true, currentMatchId: true },
    });
    for (const server of stale) {
      await this.prisma.server.update({ where: { id: server.id }, data: { status: 'OFFLINE', playerCount: 0 } });
      this.logger.warn(`Server ${server.name} missed its heartbeat: OFFLINE`);
      this.events.emit(DomainEvent.ServerStatus, { serverId: server.id, status: 'OFFLINE', previousStatus: server.status } satisfies ServerStatusPayload);
      this.events.emit(DomainEvent.ServerOffline, { serverId: server.id, matchId: server.currentMatchId });
    }
    return stale.length;
  }

  private nextStatus(reported: HeartbeatPayload['status'], reserved: boolean, maintenanceHold: boolean): ServerStatus {
    if (reported === 'ERROR') return 'ERROR';
    if (reported === 'STARTING') return 'STARTING';
    // READY or IN_USE from the plugin: the backend's reservation decides.
    if (reserved) return 'IN_USE';
    if (reported === 'IN_USE') return 'IN_USE'; // still wrapping up the previous match
    return maintenanceHold ? 'ONLINE' : 'READY';
  }

  private async reconcileMatch(serverId: string, expected: string | null, payload: HeartbeatPayload): Promise<void> {
    const reported = payload.currentMatchId;

    // The plugin lost a match that the backend considers running (crash/restart): flag it for recovery.
    if (expected && !reported && payload.status !== 'STARTING') {
      const match = await this.prisma.match.findUnique({ where: { id: expected }, select: { status: true } });
      if (match && (match.status === 'CONFIGURING' || match.status === 'LIVE')) {
        this.events.emit(DomainEvent.ServerMatchLost, { serverId, matchId: expected });
      }
    }

    // The plugin still hosts a match the backend forgot (cancelled while offline): after a grace period, order a reset.
    const staleKey = `srv:stale:${serverId}`;
    if (reported && reported !== expected) {
      const beats = await this.redis.client.incr(staleKey).catch(() => 0);
      await this.redis.client.expire(staleKey, 120).catch(() => undefined);
      if (beats >= STALE_MATCH_BEATS) {
        await this.prisma.adminAction
          .create({
            data: {
              serverId,
              matchId: null,
              type: 'MATCH_CANCEL',
              payload: { matchId: reported, reason: 'STALE_MATCH' },
              idempotencyKey: `stale:${serverId}:${reported}`,
              expiresAt: new Date(this.clock.nowMs() + 10 * 60_000),
            },
          })
          .catch(() => undefined); // duplicate idempotency key = already ordered
        await this.redis.client.del(staleKey).catch(() => undefined);
      }
    } else {
      await this.redis.client.del(staleKey).catch(() => undefined);
    }
  }
}
