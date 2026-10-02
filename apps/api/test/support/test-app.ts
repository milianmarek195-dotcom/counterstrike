import type { INestApplication, ModuleMetadata, Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { ensureSystemData } from '@celtist/database';
import { inject } from 'vitest';
import RedisMock from 'ioredis-mock';
import { AppModule } from '../../src/app.module.js';
import { Clock, FakeClock } from '../../src/common/clock.js';
import { AppConfig } from '../../src/config/app-config.js';
import type { AppEnv } from '../../src/config/env.js';
import { configureApp, installFallbackHandlers } from '../../src/core/configure-app.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { SettingsService } from '../../src/settings/settings.service.js';
import { REDIS_CLIENT } from '../../src/redis/redis.service.js';
import { testEnv } from './env.js';
import { resetDatabase } from './database.js';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  redis: InstanceType<typeof RedisMock>;
  clock: FakeClock;
  config: AppConfig;
  /** Wipes database and Redis between tests. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Extra feature modules/controllers under test. */
  imports?: ModuleMetadata['imports'];
  controllers?: Type<unknown>[];
  providers?: ModuleMetadata['providers'];
  env?: Record<string, string>;
  /** Hook to override further providers. */
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  startAt?: Date;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const databaseUrl = inject('databaseUrl');
  const env: AppEnv = testEnv(databaseUrl, options.env);
  const config = new AppConfig(env);
  const redis = new RedisMock();
  const clock = new FakeClock(options.startAt ?? new Date('2026-10-02T12:00:00.000Z'));

  let builder = Test.createTestingModule({
    imports: [AppModule.register({ jobs: false }), ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .overrideProvider(Clock)
    .useValue(clock);
  if (options.customise) builder = options.customise(builder);

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: process.env.TEST_LOGS ? ['error', 'warn'] : false });
  configureApp(app, config);
  await app.init();
  installFallbackHandlers(app);

  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    redis,
    clock,
    config,
    async reset() {
      await resetDatabase(prisma);
      await ensureSystemData(prisma); // roles, rank tiers, maps and settings, exactly as a fresh install has them
      await redis.flushall();
      app.get(SettingsService).invalidate(); // the settings cache must not leak between tests
    },
    async close() {
      await app.close();
    },
  };
}
