import type { Test } from 'supertest';
import request from 'supertest';
import { DEFAULT_ROLES, effectivePermissions, type RoleKey } from '@celtist/shared';
import { SessionService } from '../../src/security/session.service.js';
import { SESSION_COOKIE } from '../../src/security/access.js';
import type { TestApp } from './test-app.js';

let steamCounter = 0;

export function nextSteamId(): string {
  steamCounter += 1;
  return `7656119800${String(steamCounter).padStart(7, '0')}`;
}

export interface TestUser {
  id: string;
  steamId: string;
  displayName: string;
  cookie: string;
  csrf: string;
  sessionId: string;
}

/** Creates a user, optionally with roles, and a valid session – bypassing the Steam login flow. */
export async function createUser(
  t: TestApp,
  options: { roles?: RoleKey[]; displayName?: string; steamId?: string } = {},
): Promise<TestUser> {
  const steamId = options.steamId ?? nextSteamId();
  const displayName = options.displayName ?? `Player${steamId.slice(-4)}`;
  const user = await t.prisma.user.create({ data: { steamId, displayName } });
  await t.prisma.playerRank.createMany({
    data: (['FIVE_V_FIVE', 'WINGMAN'] as const).map((mode) => ({ userId: user.id, mode })),
  });
  await t.prisma.playerStats.createMany({ data: (['FIVE_V_FIVE', 'WINGMAN'] as const).map((mode) => ({ userId: user.id, mode })) });
  for (const key of options.roles ?? []) {
    const role = await t.prisma.role.findUniqueOrThrow({ where: { key } });
    await t.prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  const sessions = t.app.get(SessionService);
  const session = await sessions.create(user.id, { ip: '127.0.0.1', userAgent: 'vitest' });
  return {
    id: user.id,
    steamId,
    displayName,
    cookie: `${SESSION_COOKIE}=${session.token}`,
    csrf: sessions.csrfTokenFor(session.sessionId),
    sessionId: session.sessionId,
  };
}

/** Request helpers that attach the session cookie and (for writes) the CSRF header like the web app does. */
export function as(t: TestApp, user: TestUser | null) {
  const http = t.app.getHttpServer();
  const withAuth = (req: Test, write: boolean): Test => {
    if (!user) return req;
    req.set('Cookie', user.cookie);
    if (write) req.set('X-CSRF-Token', user.csrf).set('Origin', 'http://localhost:3000');
    return req;
  };
  return {
    get: (path: string) => withAuth(request(http).get(path), false),
    post: (path: string, body?: object) => withAuth(request(http).post(path).send(body ?? {}), true),
    put: (path: string, body?: object) => withAuth(request(http).put(path).send(body ?? {}), true),
    patch: (path: string, body?: object) => withAuth(request(http).patch(path).send(body ?? {}), true),
    delete: (path: string, body?: object) => withAuth(request(http).delete(path).send(body ?? {}), true),
  };
}

/** Permissions a default role grants (for assertions). */
export function permissionsOf(role: RoleKey): ReadonlySet<string> {
  return effectivePermissions(DEFAULT_ROLES.find((r) => r.key === role)!.permissions);
}
