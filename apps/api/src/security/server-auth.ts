import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SIGNATURE_MAX_SKEW_MS } from '@celtist/shared';
import { SIGNATURE_HEADERS, deriveServerKey, isTimestampFresh, verifySignature } from '@celtist/shared/signing';
import { Clock } from '../common/clock.js';
import { AppException, unauthorized } from '../common/errors.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ACCESS_METADATA, type AccessPolicy } from './access.js';

interface GatewayServer {
  id: string;
  keyVersion: number;
  enabled: boolean;
}

const NONCE_TTL_MS = SIGNATURE_MAX_SKEW_MS * 3;
const SERVER_CACHE_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticates a game server by the HMAC signature of the request. Every failure answers with the same
 * generic 401 so a probing client learns nothing about which part was wrong; the reason goes to the log.
 */
@Injectable()
export class ServerAuthService {
  private readonly logger = new Logger(ServerAuthService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clock: Clock,
  ) {}

  async authenticate(request: Request): Promise<GatewayServer> {
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return typeof value === 'string' ? value : undefined;
    };
    const serverId = header(SIGNATURE_HEADERS.server);
    const timestamp = Number(header(SIGNATURE_HEADERS.timestamp));
    const nonce = header(SIGNATURE_HEADERS.nonce);
    const signature = header(SIGNATURE_HEADERS.signature);

    if (!serverId || !UUID.test(serverId) || !nonce || nonce.length < 8 || nonce.length > 64 || !signature || !Number.isFinite(timestamp)) {
      throw this.reject('missing or malformed signature headers');
    }
    if (!isTimestampFresh(timestamp, this.clock.nowMs(), SIGNATURE_MAX_SKEW_MS)) {
      throw this.reject(`stale timestamp from ${serverId}`);
    }

    const server = await this.loadServer(serverId);
    if (!server || !server.enabled) throw this.reject(`unknown or disabled server ${serverId}`);

    const key = deriveServerKey(this.config.env.SERVER_API_SECRET, server.id, server.keyVersion);
    const valid = verifySignature(
      key,
      {
        method: request.method,
        pathWithQuery: request.originalUrl,
        timestampMs: timestamp,
        nonce,
        body: request.rawBody ?? '',
      },
      signature,
    );
    if (!valid) throw this.reject(`bad signature from ${serverId}`);

    // Replay protection only after the signature is known to be good, so garbage cannot fill the nonce cache.
    const fresh = await this.redis.setIfAbsent(`gw:nonce:${serverId}:${nonce}`, NONCE_TTL_MS);
    if (!fresh) throw this.reject(`replayed nonce from ${serverId}`);
    return server;
  }

  invalidate(serverId: string): Promise<number> {
    return this.redis.client.del(`gw:server:${serverId}`);
  }

  private async loadServer(id: string): Promise<GatewayServer | null> {
    return this.redis.remember<GatewayServer | null>(`gw:server:${id}`, SERVER_CACHE_SECONDS, async () => {
      const row = await this.prisma.server.findUnique({ where: { id }, select: { id: true, keyVersion: true, enabled: true } });
      return row ?? null;
    });
  }

  private reject(reason: string): AppException {
    this.logger.warn(`Gateway authentication failed: ${reason}`);
    return unauthorized('Invalid server credentials', 'INVALID_SIGNATURE');
  }
}

/** Global guard: only acts on routes declared with @ServerOnly(); runs before rate limiting so limits count per server. */
@Injectable()
export class ServerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly serverAuth: ServerAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_METADATA, [context.getHandler(), context.getClass()]);
    if (policy?.kind !== 'server') return true;
    const request = context.switchToHttp().getRequest<Request>();
    // A cookie session never authorises gateway calls.
    delete request.auth;
    const server = await this.serverAuth.authenticate(request);
    request.gatewayServerId = server.id;
    return true;
  }
}
