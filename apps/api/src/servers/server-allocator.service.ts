import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PrismaClient, type TransactionClient } from '@celtist/database';
import { SERVER_OFFLINE_AFTER_MS, SERVER_RESERVATION_TTL_MS } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';

type Db = PrismaClient | TransactionClient;

export interface ReservedServer {
  id: string;
  name: string;
  ip: string;
  port: number;
}

export interface ReserveOptions {
  /** Restrict to these servers (tournament server list); empty/undefined = any. */
  allowedServerIds?: readonly string[];
}

/**
 * Server pool allocation. A server can host exactly one match at a time, guaranteed twice over:
 *  1. one atomic UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) – concurrent allocators never
 *     pick the same row and never wait for each other;
 *  2. a unique constraint on servers.currentMatchId – a match cannot hold two servers either.
 * Reservations carry an expiry so a server is not blocked forever by a match that never started.
 */
@Injectable()
export class ServerAllocator {
  private readonly logger = new Logger(ServerAllocator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Reserves a READY server with a fresh heartbeat for the match, or returns null when none is free. */
  async reserve(matchId: string, options: ReserveOptions = {}, db: Db = this.prisma): Promise<ReservedServer | null> {
    const now = this.clock.now();
    const freshAfter = new Date(now.getTime() - SERVER_OFFLINE_AFTER_MS);
    const reservedUntil = new Date(now.getTime() + SERVER_RESERVATION_TTL_MS);

    const filters: Prisma.Sql[] = [
      Prisma.sql`s."status" = 'READY'::"ServerStatus"`,
      Prisma.sql`s."enabled"`,
      Prisma.sql`NOT s."maintenanceHold"`,
      Prisma.sql`s."currentMatchId" IS NULL`,
      Prisma.sql`s."lastHeartbeatAt" > ${freshAfter}`,
    ];
    if (options.allowedServerIds && options.allowedServerIds.length > 0) {
      filters.push(Prisma.sql`s."id" IN (${Prisma.join(options.allowedServerIds.map((id) => Prisma.sql`${id}::uuid`))})`);
    }

    // Idempotent per match: a second request (event handler and job tick racing) gets the server already held.
    const held = await db.server.findUnique({ where: { currentMatchId: matchId }, select: { id: true, name: true, ip: true, port: true } });
    if (held) return held;

    {
      const rows = await db.$queryRaw<ReservedServer[]>(Prisma.sql`
        UPDATE "servers" SET
          "status" = 'IN_USE'::"ServerStatus",
          "currentMatchId" = ${matchId}::uuid,
          "reservedUntil" = ${reservedUntil},
          "updatedAt" = now()
        WHERE "id" = (
          SELECT s."id" FROM "servers" s
          WHERE ${Prisma.join(filters, ' AND ')}
          ORDER BY s."updatedAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "name", "ip", "port"`);
      return rows[0] ?? null;
    }
  }

  /**
   * Frees the server of a match. The status is deliberately left alone: only the plugin's next heartbeat
   * ("idle again") moves the server back to READY, so a server still wrapping up is never handed out.
   */
  async release(matchId: string, db: Db = this.prisma): Promise<string | null> {
    const server = await db.server.findUnique({ where: { currentMatchId: matchId }, select: { id: true } });
    if (!server) return null;
    await db.server.update({ where: { id: server.id }, data: { currentMatchId: null, reservedUntil: null } });
    this.logger.log(`Released server ${server.id} from match ${matchId}`);
    return server.id;
  }

  /** The match went live: the reservation no longer expires. */
  async pinReservation(matchId: string, db: Db = this.prisma): Promise<void> {
    await db.server.updateMany({ where: { currentMatchId: matchId }, data: { reservedUntil: null } });
  }

  /** Matches whose reservation expired before they went live (they will be re-queued by the lifecycle job). */
  async findExpiredReservations(db: Db = this.prisma): Promise<Array<{ serverId: string; matchId: string }>> {
    const servers = await db.server.findMany({
      where: { currentMatchId: { not: null }, reservedUntil: { lt: this.clock.now() } },
      select: { id: true, currentMatchId: true },
    });
    return servers.map((s) => ({ serverId: s.id, matchId: s.currentMatchId! }));
  }
}
