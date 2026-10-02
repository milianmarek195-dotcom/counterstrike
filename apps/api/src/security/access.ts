import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@celtist/shared';

/** Identity of the caller, attached to the request by AuthContextGuard when a valid session cookie is present. */
export interface AuthContext {
  userId: string;
  steamId: string;
  displayName: string;
  sessionId: string;
  permissions: ReadonlySet<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Set by ServerAuthGuard for authenticated game-server requests. */
      gatewayServerId?: string;
      rawBody?: Buffer;
    }
  }
}

/**
 * Every route declares who may call it. The AccessGuard enforces the declaration; routes that change
 * state without one are rejected (fail closed), and a test asserts that no route is undeclared.
 */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permissions: readonly Permission[] }
  | { kind: 'server' };

export const ACCESS_METADATA = 'celtist:access';

/** Anyone, including anonymous visitors (read-only data, login endpoints). */
export const Public = () => SetMetadata(ACCESS_METADATA, { kind: 'public' } satisfies AccessPolicy);
/** Any signed-in user. */
export const Authenticated = () => SetMetadata(ACCESS_METADATA, { kind: 'authenticated' } satisfies AccessPolicy);
/** Signed-in user holding ALL listed permissions. */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(ACCESS_METADATA, { kind: 'permission', permissions } satisfies AccessPolicy);
/** Game-server gateway: authenticated by request signature (ServerAuthGuard), not by cookie. */
export const ServerOnly = () => SetMetadata(ACCESS_METADATA, { kind: 'server' } satisfies AccessPolicy);

/** Injects the AuthContext; only valid on routes with an Authenticated/RequirePermission policy. */
export const CurrentAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext => {
  const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
  if (!request.auth) throw new Error('CurrentAuth used on a route without an authenticated policy');
  return request.auth;
});

/** Same as CurrentAuth but yields undefined for anonymous callers (routes with a Public policy). */
export const OptionalAuth = createParamDecorator((_data: unknown, context: ExecutionContext): AuthContext | undefined => {
  return context.switchToHttp().getRequest<{ auth?: AuthContext }>().auth;
});

export const SESSION_COOKIE = 'celtist_session';
export const OPENID_STATE_COOKIE = 'celtist_oidstate';
export const CSRF_HEADER = 'x-csrf-token';
