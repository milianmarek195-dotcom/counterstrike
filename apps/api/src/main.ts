import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { EnvValidationError, loadDotenvFile, loadEnv } from './config/env.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';
import { configureApp, installFallbackHandlers } from './core/configure-app.js';

async function bootstrap(): Promise<void> {
  loadDotenvFile();

  // Fail fast with a readable message instead of a stack trace when the environment is wrong.
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const jobs = env.APP_ROLE !== 'http';
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register({ jobs }), {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const adapter = new RedisIoAdapter(app);
  adapter.connect(env.REDIS_URL);
  app.useWebSocketAdapter(adapter);
  configureApp(app, app.get(AppConfig));
  await app.init();

  if (env.APP_ROLE === 'worker') {
    app.get(Logger).log('Worker started (no HTTP listener)');
    return;
  }
  installFallbackHandlers(app);
  await app.listen(env.API_PORT, '0.0.0.0');
  app.get(Logger).log(`API listening on port ${env.API_PORT}`);
}

await bootstrap();
