import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import { hasAllPermissions } from '@celtist/shared';
import { AppConfig } from '../config/app-config.js';
import { AppException, forbidden, unauthorized } from '../common/errors.js';
import { ACCESS_METADATA, CSRF_HEADER, SESSION_COOKIE, type AccessPolicy } from './access.js';
import { PermissionResolver } from './permission-resolver.service.js';
import { SessionService } from './session.service.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function clearedSessionCookie(config: AppConfig): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    maxAge: 0,
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    ...(config.env.COOKIE_DOMAIN ? { domain: config.env.COOKIE_DOMAIN } : {}),
  });
}

/**
 * Runs first: reads the session cookie and, if it is valid, attaches the caller's identity and permissions to
 * the request. Never rejects – whether anonymous access is acceptable is decided per route by AccessGuard.
 */
@Injectable()
export class AuthContextGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly permissions: PermissionResolver,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const header = request.headers.cookie;
    if (!header) return true;

    const token = parseCookie(header)[SESSION_COOKIE];
    if (!token) return true;

    const session = await this.sessions.authenticate(token);
    if (!session) {
      // Stale or forged cookie: tell the browser to drop it.
      http.getResponse<Response>().append('Set-Cookie', clearedSessionCookie(this.config));
      return true;
    }
    request.auth = {
      userId: session.userId,
      steamId: session.steamId,
      displayName: session.displayName,
      sessionId: session.sessionId,
      permissions: await this.permissions.forUser(session.userId),
    };
    return true;
  }
}

/**
 * CSRF protection for cookie-authenticated requests that change state: the Origin header (if present) must
 * be a known origin, and the per-session token must be sent in X-CSRF-Token. SameSite=Lax cookies are the
 * first line of defence; this is the second.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.auth || SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin;
    if (typeof origin === 'string' && !this.config.allowedOrigins.includes(origin)) {
      throw forbidden('Cross-site request blocked', 'CSRF_ORIGIN');
    }
    const token = request.headers[CSRF_HEADER];
    if (!this.sessions.verifyCsrfToken(request.auth.sessionId, typeof token === 'string' ? token : undefined)) {
      throw forbidden('Missing or invalid CSRF token', 'CSRF_INVALID');
    }
    return true;
  }
}

/** Enforces the route's declared AccessPolicy. Undeclared state-changing routes are refused (fail closed). */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!policy) {
      if (SAFE_METHODS.has(request.method)) return true;
      this.logger.error(`No access policy declared for ${request.method} ${request.path}`);
      throw new AppException('ACCESS_POLICY_MISSING', 'This route is not available', 500);
    }

    switch (policy.kind) {
      case 'public':
        return true;
      case 'server':
        // ServerAuthGuard has already verified the signature; this is the second lock on the same door.
        if (!request.gatewayServerId) throw unauthorized('Invalid server credentials', 'INVALID_SIGNATURE');
        return true;
      case 'authenticated':
        if (!request.auth) throw unauthorized();
        return true;
      case 'permission': {
        if (!request.auth) throw unauthorized();
        if (!hasAllPermissions(request.auth.permissions, policy.permissions)) {
          throw forbidden(`Missing permission: ${policy.permissions.join(', ')}`);
        }
        return true;
      }
    }
  }
}
