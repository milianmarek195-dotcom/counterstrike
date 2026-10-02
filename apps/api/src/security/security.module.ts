import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '../common/rate-limit.js';
import { AccessGuard, AuthContextGuard, CsrfGuard } from './guards.js';
import { PermissionResolver } from './permission-resolver.service.js';
import { ServerAuthGuard, ServerAuthService } from './server-auth.js';
import { SessionService } from './session.service.js';

/**
 * Global request security. Guard order matters and is fixed here:
 *  1. AuthContextGuard – who is calling by cookie (never rejects)
 *  2. ServerAuthGuard  – game-server routes: verify the request signature
 *  3. RateLimitGuard   – counts per server/user/IP
 *  4. CsrfGuard        – cookie-authenticated state changes need the token
 *  5. AccessGuard      – the route's declared policy
 */
@Global()
@Module({
  providers: [
    SessionService,
    PermissionResolver,
    ServerAuthService,
    { provide: APP_GUARD, useClass: AuthContextGuard },
    { provide: APP_GUARD, useClass: ServerAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [SessionService, PermissionResolver, ServerAuthService],
})
export class SecurityModule {}
