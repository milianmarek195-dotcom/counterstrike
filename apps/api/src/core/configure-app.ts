import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppConfig } from '../config/app-config.js';

/**
 * Call after `app.init()`: requests outside the /v1 prefix never reach Nest's router, so Express would answer
 * with its HTML "Cannot GET" page. This fallback keeps every answer in the standard JSON error format.
 */
export function installFallbackHandlers(app: INestApplication): void {
  const server = app.getHttpAdapter().getInstance() as import('express').Express;
  server.use((req: import('express').Request, res: import('express').Response) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: 'Route not found',
      ...(res.getHeader('x-request-id') ? { requestId: String(res.getHeader('x-request-id')) } : {}),
    });
  });
}

/**
 * Express-level hardening shared by production and e2e tests: proxy trust, security headers, CORS,
 * body size limits. (Validation, error format and rate limiting live in CoreModule.)
 */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', config.env.TRUST_PROXY === 0 ? false : config.env.TRUST_PROXY);
  express.disable('x-powered-by');
  // Public API lives under /v1; health checks and the game-server gateway (/server/v1) keep their own paths.
  express.setGlobalPrefix('v1', { exclude: ['health', 'health/ready', 'server/{*path}'] });

  express.use(
    helmet({
      // The API only returns JSON: forbid everything a response could load or be framed by.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  const allowed = new Set(config.allowedOrigins);
  express.enableCors({
    // Requests without an Origin (the CS2 plugin, curl, server-side rendering) are not CORS requests.
    origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'ratelimit-limit', 'ratelimit-remaining', 'retry-after'],
    maxAge: 600,
  });

  express.useBodyParser('json', { limit: '256kb' });
}
