import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60_000;
export const SESSION_MAX_PER_USER = 10;
const TOUCH_INTERVAL_MS = 5 * 60_000;
const CACHE_TTL_SECONDS = 60;

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthenticatedSession {
  sessionId: string;
  userId: string;
  steamId: string;
  displayName: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

interface CachedSession {
  sessionId: string;
  userId: string;
  steamId: string;
  displayName: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Server-side sessions. The browser holds an opaque 256-bit token; the database stores only its SHA-256 hash,
 * so a database leak does not yield usable cookies. Sessions can be revoked instantly (logout, admin, password-less reset).
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  async create(userId: string, meta: SessionMeta = {}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
    const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_MS);

    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashSessionToken(token),
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      },
    });
    await this.enforceSessionLimit(userId);
    return { token, sessionId: session.id, expiresAt: absoluteExpiresAt };
  }

  /** Resolves a cookie token to a live session, or null (unknown, revoked, idle- or absolute-expired). */
  async authenticate(token: string): Promise<AuthenticatedSession | null> {
    if (token.length < 20 || token.length > 128) return null;
    const hash = hashSessionToken(token);
    const now = this.clock.now();

    const cached = await this.readCache(hash);
    if (cached) {
      const view = this.toSession(cached);
      return this.isLive(view, now) ? view : null;
    }

    const row = await this.prisma.session.findUnique({
      where: { tokenHash: hash },
      include: { user: { select: { id: true, steamId: true, displayName: true } } },
    });
    if (!row || row.revokedAt) return null;
    const view: AuthenticatedSession = {
      sessionId: row.id,
      userId: row.user.id,
      steamId: row.user.steamId,
      displayName: row.user.displayName,
      idleExpiresAt: row.idleExpiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
    };
    if (!this.isLive(view, now)) return null;

    if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idle = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, row.absoluteExpiresAt.getTime()));
      view.idleExpiresAt = idle;
      await this.prisma.session
        .update({ where: { id: row.id }, data: { lastSeenAt: now, idleExpiresAt: idle } })
        .catch((error: Error) => this.logger.warn(`Could not touch session: ${error.message}`));
    }
    await this.writeCache(hash, view);
    return view;
  }

  async revoke(sessionId: string, userId?: string): Promise<boolean> {
    const row = await this.prisma.session.findFirst({
      where: { id: sessionId, ...(userId ? { userId } : {}), revokedAt: null },
    });
    if (!row) return false;
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: this.clock.now() } });
    await this.redis.client.del(this.cacheKey(row.tokenHash)).catch(() => undefined);
    return true;
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true, tokenHash: true },
    });
    if (rows.length === 0) return 0;
    await this.prisma.session.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { revokedAt: this.clock.now() } });
    await this.redis.client.del(...rows.map((r) => this.cacheKey(r.tokenHash))).catch(() => undefined);
    return rows.length;
  }

  async listForUser(userId: string, currentSessionId?: string) {
    const now = this.clock.now();
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: now }, idleExpiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      ip: row.ip,
      userAgent: row.userAgent,
      current: row.id === currentSessionId,
    }));
  }

  /** Housekeeping (job): removes sessions that can never be valid again. */
  async purgeExpired(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const result = await this.prisma.session.deleteMany({
      where: { OR: [{ absoluteExpiresAt: { lt: now } }, { idleExpiresAt: { lt: now } }, { revokedAt: { lt: cutoff } }] },
    });
    return result.count;
  }

  /** Per-session CSRF token: HMAC of the session id with the server secret; never stored. */
  csrfTokenFor(sessionId: string): string {
    return createHmac('sha256', this.config.env.SESSION_SECRET).update(`csrf:${sessionId}`).digest('base64url');
  }

  verifyCsrfToken(sessionId: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const expected = Buffer.from(this.csrfTokenFor(sessionId));
    const actual = Buffer.from(presented);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private isLive(session: AuthenticatedSession, now: Date): boolean {
    return session.idleExpiresAt.getTime() > now.getTime() && session.absoluteExpiresAt.getTime() > now.getTime();
  }

  private async enforceSessionLimit(userId: string): Promise<void> {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tokenHash: true },
      skip: SESSION_MAX_PER_USER,
    });
    if (active.length === 0) return;
    await this.prisma.session.updateMany({ where: { id: { in: active.map((s) => s.id) } }, data: { revokedAt: this.clock.now() } });
    await this.redis.client.del(...active.map((s) => this.cacheKey(s.tokenHash))).catch(() => undefined);
  }

  private cacheKey(hash: string): string {
    return `sess:${hash}`;
  }

  private async readCache(hash: string): Promise<CachedSession | null> {
    try {
      return await this.redis.getJson<CachedSession>(this.cacheKey(hash));
    } catch {
      return null;
    }
  }

  private async writeCache(hash: string, session: AuthenticatedSession): Promise<void> {
    const remaining = Math.min(session.idleExpiresAt.getTime(), session.absoluteExpiresAt.getTime()) - this.clock.nowMs();
    const ttl = Math.min(CACHE_TTL_SECONDS, Math.floor(remaining / 1000));
    if (ttl <= 0) return;
    const value: CachedSession = {
      sessionId: session.sessionId,
      userId: session.userId,
      steamId: session.steamId,
      displayName: session.displayName,
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
    };
    try {
      await this.redis.setJson(this.cacheKey(hash), value, ttl);
    } catch {
      // cache only
    }
  }

  private toSession(cached: CachedSession): AuthenticatedSession {
    return {
      ...cached,
      idleExpiresAt: new Date(cached.idleExpiresAt),
      absoluteExpiresAt: new Date(cached.absoluteExpiresAt),
    };
  }
}
