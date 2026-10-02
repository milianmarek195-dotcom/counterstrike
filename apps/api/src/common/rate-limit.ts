import {
  CanActivate,
  ExecutionContext,
  Global,
  Injectable,
  Logger,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RedisService } from '../redis/redis.service.js';
import { tooManyRequests } from './errors.js';

export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  windowSeconds: number;
  /** Group name: requests with the same name share one counter per client. */
  name?: string;
}

const RATE_LIMIT_KEY = 'celtist:rate-limit';
const SKIP_RATE_LIMIT_KEY = 'celtist:skip-rate-limit';

/** Per-route override of the global limit (e.g. strict limits on authentication endpoints). */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { limit: 300, windowSeconds: 60, name: 'global' };

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Fixed-window counter in Redis. Self-healing: a counter without TTL (crash between INCR and PEXPIRE) gets one. */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  async hit(key: string, options: RateLimitOptions): Promise<RateLimitDecision> {
    const windowMs = options.windowSeconds * 1000;
    const redisKey = `rl:${key}`;
    try {
      const replies = await this.redis.client.multi().incr(redisKey).pttl(redisKey).exec();
      const count = Number(replies?.[0]?.[1] ?? 1);
      let ttl = Number(replies?.[1]?.[1] ?? -1);
      if (ttl < 0) {
        await this.redis.client.pexpire(redisKey, windowMs);
        ttl = windowMs;
      }
      const allowed = count <= options.limit;
      return {
        allowed,
        limit: options.limit,
        remaining: Math.max(0, options.limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
      };
    } catch (error) {
      // Availability beats strictness: if Redis is down we let the request through and say so.
      this.logger.warn(`Rate limiter unavailable (${(error as Error).message}); allowing request`);
      return { allowed: true, limit: options.limit, remaining: options.limit, retryAfterSeconds: 0 };
    }
  }
}

/** Global guard: counts by client IP (or by user/server id when the request is already identified). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, targets)) return true;

    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, targets) ?? DEFAULT_RATE_LIMIT;
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { auth?: { userId?: string }; gatewayServerId?: string }>();
    const response = http.getResponse<Response>();

    const subject = request.gatewayServerId
      ? `srv:${request.gatewayServerId}`
      : request.auth?.userId
        ? `usr:${request.auth.userId}`
        : `ip:${request.ip ?? 'unknown'}`;
    const decision = await this.limiter.hit(`${options.name ?? 'global'}:${subject}`, options);

    response.setHeader('RateLimit-Limit', String(decision.limit));
    response.setHeader('RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds);
    return true;
  }
}

@Global()
@Module({
  providers: [RateLimiter, RateLimitGuard],
  exports: [RateLimiter, RateLimitGuard],
})
export class RateLimitModule {}
