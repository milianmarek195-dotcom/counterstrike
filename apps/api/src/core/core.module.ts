import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AllExceptionsFilter } from '../common/all-exceptions.filter.js';
import { Clock, SystemClock } from '../common/clock.js';
import { RateLimitModule } from '../common/rate-limit.js';
import { createValidationPipe } from '../common/validation.js';
import { ConfigModule } from '../config/app-config.js';
import { DatabaseModule } from '../database/prisma.service.js';
import { HealthController } from '../health/health.controller.js';
import { RedisModule } from '../redis/redis.service.js';
import { SecurityModule } from '../security/security.module.js';

/**
 * Infrastructure shared by every feature module: configuration, database, Redis, events, rate limiting,
 * request security, the global validation pipe and error filter. Tests import this module too, so they
 * exercise the same request pipeline as production.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    RateLimitModule,
    SecurityModule,
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.', maxListeners: 50 }),
  ],
  controllers: [HealthController],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [Clock],
})
export class CoreModule {}
