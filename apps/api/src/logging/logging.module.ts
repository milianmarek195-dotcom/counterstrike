import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Structured JSON logging (pino). Only a small, safe subset of each request is logged: no headers,
 * no cookies, no query string (OpenID callbacks carry signatures in the query).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.env.LOG_LEVEL,
          genReqId: (req: IncomingMessage, res: ServerResponse) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
            res.setHeader('x-request-id', id);
            return id;
          },
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              path: req.url.split('?')[0],
            }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          redact: {
            paths: [
              '*.password',
              '*.token',
              '*.secret',
              '*.authorization',
              '*.cookie',
              '*.signature',
              'req.headers',
              'res.headers',
            ],
            censor: '[redacted]',
          },
          customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) => {
            if (error || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
          transport:
            config.env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
