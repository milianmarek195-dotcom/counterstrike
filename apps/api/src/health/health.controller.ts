import { Controller, Get, HttpStatus } from '@nestjs/common';
import { SkipRateLimit } from '../common/rate-limit.js';
import { AppException } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { Public } from '../security/access.js';

@Controller('health')
@Public()
@SkipRateLimit()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process answers. Used by container health checks. */
  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. A failing dependency yields 503 so the proxy stops routing here. */
  @Get('ready')
  async readiness(): Promise<{ status: 'ok'; checks: Record<string, 'up'> }> {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);
    if (!database || !redis) {
      throw new AppException('NOT_READY', 'A dependency is unavailable', HttpStatus.SERVICE_UNAVAILABLE, {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      });
    }
    return { status: 'ok', checks: { database: 'up', redis: 'up' } };
  }
}
