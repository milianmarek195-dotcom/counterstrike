import { Injectable, Logger } from '@nestjs/common';
import { type AdminAction, type AdminActionType, type PrismaClient, type TransactionClient, isUniqueViolation } from '@celtist/database';
import { Clock } from '../common/clock.js';
import { notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';

type Db = PrismaClient | TransactionClient;

export interface IssueCommand {
  serverId: string;
  matchId?: string | null;
  type: AdminActionType;
  payload?: Record<string, unknown>;
  issuedById?: string | null;
  /** Repeating the same key returns the first command instead of creating a duplicate. */
  idempotencyKey?: string;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60_000;
/** A delivered command that was not acknowledged within this time is offered again (plugin crash safety). */
const REDELIVER_AFTER_MS = 30_000;
const POLL_INTERVAL_MS = 1000;

/**
 * Commands directed at game servers. The plugin long-polls them; every command has an id, is acknowledged
 * explicitly, expires, and may be delivered more than once – plugins must treat the command id as idempotent.
 */
@Injectable()
export class MatchCommandService {
  private readonly logger = new Logger(MatchCommandService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async issue(command: IssueCommand, db: Db = this.prisma): Promise<AdminAction> {
    try {
      return await db.adminAction.create({
        data: {
          serverId: command.serverId,
          matchId: command.matchId ?? null,
          type: command.type,
          payload: (command.payload ?? {}) as never,
          issuedById: command.issuedById ?? null,
          idempotencyKey: command.idempotencyKey ?? null,
          expiresAt: new Date(this.clock.nowMs() + (command.ttlMs ?? DEFAULT_TTL_MS)),
        },
      });
    } catch (error) {
      if (command.idempotencyKey && isUniqueViolation(error)) {
        const existing = await db.adminAction.findUnique({ where: { idempotencyKey: command.idempotencyKey } });
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Pending commands for a server (oldest first). With `waitSeconds` the call holds the connection open until
   * something is available (long-poll), so admin actions reach the server within about a second.
   */
  async fetchForServer(serverId: string, waitSeconds: number): Promise<AdminAction[]> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const now = this.clock.now();
      const rows = await this.prisma.adminAction.findMany({
        where: {
          serverId,
          expiresAt: { gt: now },
          OR: [{ status: 'PENDING' }, { status: 'DELIVERED', deliveredAt: { lt: new Date(now.getTime() - REDELIVER_AFTER_MS) } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      if (rows.length > 0) {
        await this.prisma.adminAction.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'DELIVERED', deliveredAt: now } });
        return rows;
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  async acknowledge(serverId: string, actionId: string, status: 'ACKED' | 'FAILED', reason?: string): Promise<void> {
    const action = await this.prisma.adminAction.findFirst({ where: { id: actionId, serverId } });
    if (!action) throw notFound('COMMAND_NOT_FOUND', 'Command does not exist');
    if (action.status === 'ACKED' || action.status === 'FAILED') return; // acknowledging twice is harmless
    await this.prisma.adminAction.update({
      where: { id: actionId },
      data: { status, ackedAt: this.clock.now(), failureReason: status === 'FAILED' ? (reason ?? 'unspecified').slice(0, 300) : null },
    });
    if (status === 'FAILED') this.logger.warn(`Command ${action.type} ${actionId} failed on server ${serverId}: ${reason}`);
  }

  /** Housekeeping: commands that were never acknowledged in time are marked EXPIRED. */
  async expireOld(): Promise<number> {
    const result = await this.prisma.adminAction.updateMany({
      where: { status: { in: ['PENDING', 'DELIVERED'] }, expiresAt: { lt: this.clock.now() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }
}
