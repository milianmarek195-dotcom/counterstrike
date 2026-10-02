import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import RedisMock from 'ioredis-mock';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { loadDotenvFile, loadEnv } from './config/env.js';
import { configureApp, installFallbackHandlers } from './core/configure-app.js';
import { DevLoginController } from './dev/dev-login.controller.js';
import { REDIS_CLIENT } from './redis/redis.service.js';

/**
 * LOCAL DEVELOPMENT ONLY (never used by the Docker image): runs the API with an in-memory Redis replacement so a
 * Windows machine without Redis can still run the stack. State in Redis (sessions cache, rate limits, nonces) is lost
 * on restart, and background jobs are off. Production uses src/main.ts with a real Redis.
 */
async function bootstrap(): Promise<void> {
  loadDotenvFile();
  const env = loadEnv();
  const { Test } = await import('@nestjs/testing');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register({ jobs: false })], controllers: [DevLoginController] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(new RedisMock())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app, app.get(AppConfig));
  await app.init();
  installFallbackHandlers(app);
  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`[dev-api] listening on http://localhost:${env.API_PORT} (in-memory Redis, jobs off)`);
}

await bootstrap();
