import { Controller, Delete, Get, HttpCode, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RateLimit } from '../common/rate-limit.js';
import { notFound } from '../common/errors.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  Authenticated,
  CurrentAuth,
  OPENID_STATE_COOKIE,
  OptionalAuth,
  Public,
  SESSION_COOKIE,
  type AuthContext,
} from '../security/access.js';
import { clearedSessionCookie } from '../security/guards.js';
import { PermissionResolver } from '../security/permission-resolver.service.js';
import { SessionService } from '../security/session.service.js';
import { OpenIdError, SteamOpenIdService, type OpenIdQuery } from '../steam/steam-openid.service.js';
import { UsersService } from '../users/users.service.js';

const loginQuery = z.object({ returnTo: z.string().max(200).optional() });
const idParam = z.uuid();

const AUTH_RATE_LIMIT = { limit: 20, windowSeconds: 60, name: 'auth' } as const;

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly openId: SteamOpenIdService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionResolver,
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** Step 1: send the browser to Steam. A one-time state cookie ties the later callback to this browser. */
  @Get('steam/login')
  @Public()
  @RateLimit(AUTH_RATE_LIMIT)
  async login(@Query({ schema: loginQuery }) query: z.infer<typeof loginQuery>, @Res() res: Response): Promise<void> {
    const { redirectUrl, state } = await this.openId.startLogin(query.returnTo);
    res.append('Set-Cookie', this.stateCookie(state, 600));
    res.redirect(302, redirectUrl);
  }

  /** Step 2: Steam sends the browser back; we verify, create/refresh the account and open a session. */
  @Get('steam/callback')
  @Public()
  @RateLimit(AUTH_RATE_LIMIT)
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const stateCookie = parseCookie(req.headers.cookie ?? '')[OPENID_STATE_COOKIE];
    try {
      const { steamId, returnTo } = await this.openId.completeLogin(req.query as OpenIdQuery, stateCookie);
      const user = await this.users.upsertFromSteamLogin(steamId);
      const session = await this.sessions.create(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });

      res.append('Set-Cookie', this.sessionCookie(session.token, session.expiresAt));
      res.append('Set-Cookie', this.stateCookie('', 0));
      res.redirect(302, this.webUrl(returnTo));
    } catch (error) {
      if (!(error instanceof OpenIdError)) throw error;
      this.logger.warn(`Steam login rejected: ${error.reason}`);
      res.append('Set-Cookie', this.stateCookie('', 0));
      res.redirect(302, this.webUrl(`/login/failed?reason=${encodeURIComponent(error.reason)}`));
    }
  }

  @Post('logout')
  @Authenticated()
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.revoke(auth.sessionId, auth.userId);
    res.append('Set-Cookie', clearedSessionCookie(this.config));
  }

  /** Signs out every other device. */
  @Post('logout-others')
  @Authenticated()
  async logoutOthers(@CurrentAuth() auth: AuthContext): Promise<{ revoked: number }> {
    return { revoked: await this.sessions.revokeAllForUser(auth.userId, auth.sessionId) };
  }

  /** Who am I? Always 200 so the web app can render signed-out state without error noise. */
  @Get('me')
  @Public()
  async me(@OptionalAuth() auth: AuthContext | undefined) {
    if (!auth) return { user: null, roles: [], permissions: [], csrfToken: null };
    const [user, roles] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: auth.userId },
        select: { id: true, steamId: true, displayName: true, avatarUrl: true, createdAt: true },
      }),
      this.permissions.rolesForUser(auth.userId),
    ]);
    return {
      user,
      roles,
      permissions: [...auth.permissions].sort(),
      csrfToken: this.sessions.csrfTokenFor(auth.sessionId),
    };
  }

  @Get('sessions')
  @Authenticated()
  async listSessions(@CurrentAuth() auth: AuthContext) {
    return { sessions: await this.sessions.listForUser(auth.userId, auth.sessionId) };
  }

  @Delete('sessions/:id')
  @Authenticated()
  @HttpCode(204)
  async revokeSession(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    const revoked = await this.sessions.revoke(id, auth.userId);
    if (!revoked) throw notFound('SESSION_NOT_FOUND', 'Session does not exist');
  }

  private sessionCookie(token: string, expiresAt: Date): string {
    return stringifySetCookie({
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
      ...(this.config.env.COOKIE_DOMAIN ? { domain: this.config.env.COOKIE_DOMAIN } : {}),
    });
  }

  private stateCookie(value: string, maxAge: number): string {
    return stringifySetCookie({
      name: OPENID_STATE_COOKIE,
      value,
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/v1/auth/steam',
      maxAge,
    });
  }

  /** Post-login redirects always land on the web origin, whatever the path says. */
  private webUrl(path: string): string {
    const url = new URL(path, this.config.webOrigin);
    return url.origin === this.config.webOrigin ? url.toString() : this.config.webOrigin;
  }
}
