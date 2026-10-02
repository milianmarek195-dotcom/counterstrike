import { ModulesContainer, Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPermission } from '@celtist/shared';
import { ACCESS_METADATA, type AccessPolicy } from '../src/security/access.js';
import { createTestApp, type TestApp } from './support/test-app.js';

interface RouteInfo {
  controller: string;
  handler: string;
  httpMethod: number;
  controllerPath: string;
  policy: AccessPolicy | undefined;
}

/**
 * Safety net for the access model: every route of every controller must declare who may call it. A new route
 * that forgets @Public / @Authenticated / @RequirePermission / @ServerOnly fails this test instead of silently
 * shipping with the wrong exposure.
 */
describe('route access policy', () => {
  let t: TestApp;
  let routes: RouteInfo[];

  beforeAll(async () => {
    t = await createTestApp();
    const reflector = new Reflector();
    routes = [];
    for (const module of t.app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const instance = wrapper.instance as object | undefined;
        if (!instance || !wrapper.metatype) continue;
        const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const httpMethod = Reflect.getMetadata('method', handler) as number | undefined;
          if (httpMethod === undefined) continue;
          routes.push({
            controller: wrapper.metatype.name,
            handler: name,
            httpMethod,
            controllerPath: String(Reflect.getMetadata('path', wrapper.metatype) ?? ''),
            policy: reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_METADATA, [handler as never, wrapper.metatype]),
          });
        }
      }
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('discovers the application routes', () => {
    expect(routes.length).toBeGreaterThan(5);
  });

  it('every route declares an access policy', () => {
    const undeclared = routes.filter((r) => !r.policy).map((r) => `${r.controller}.${r.handler}`);
    expect(undeclared, `Routes without @Public/@Authenticated/@RequirePermission/@ServerOnly:\n${undeclared.join('\n')}`).toEqual([]);
  });

  it('permission policies only reference real permissions', () => {
    for (const route of routes) {
      if (route.policy?.kind !== 'permission') continue;
      expect(route.policy.permissions.length, `${route.controller}.${route.handler}`).toBeGreaterThan(0);
      for (const permission of route.policy.permissions) expect(isPermission(permission)).toBe(true);
    }
  });

  it('admin controllers are never public or merely authenticated', () => {
    const adminRoutes = routes.filter((r) => r.controllerPath.startsWith('admin'));
    for (const route of adminRoutes) {
      expect(['permission'], `${route.controller}.${route.handler}`).toContain(route.policy?.kind);
    }
  });

  it('game-server gateway routes use signature authentication', () => {
    const gateway = routes.filter((r) => r.controllerPath.startsWith('server/'));
    for (const route of gateway) expect(route.policy?.kind, `${route.controller}.${route.handler}`).toBe('server');
  });
});
