import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { stringifySetCookie } from 'cookie';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { Public, SESSION_COOKIE } from '../security/access.js';
import { SessionService } from '../security/session.service.js';
import { notFound } from '../common/errors.js';

const body = z.object({ steamId: z.string().regex(/^7656119\d{10}$/) });

/**
 * LOCAL DEVELOPMENT ONLY. Registered exclusively by src/dev-main.ts, so the production entry point does not even
 * contain the route. It signs in an existing (seeded) user without Steam so the UI can be tried on a laptop.
 */
@Controller('dev')
export class DevLoginController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly config: AppConfig,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(204)
  async login(@Body({ schema: body }) input: z.infer<typeof body>, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw notFound('NOT_FOUND', 'Not found');
    const user = await this.prisma.user.findUnique({ where: { steamId: input.steamId } });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Unknown player (run npm run db:seed first)');
    const session = await this.sessions.create(user.id, { userAgent: 'dev-login' });
    res.append('Set-Cookie', stringifySetCookie({ name: SESSION_COOKIE, value: session.token, httpOnly: true, secure: this.config.cookieSecure, sameSite: 'lax', path: '/', maxAge: 7 * 86400 }));
  }
}
