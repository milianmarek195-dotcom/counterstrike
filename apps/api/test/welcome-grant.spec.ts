import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SettingsService } from '../src/settings/settings.service.js';
import { SkinPermissionsService } from '../src/skins/skin-permissions.service.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('welcome skin grant at first login', () => {
  let t: TestApp;
  const DAY = 86_400_000;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  const login = (steamId: string) => t.app.get(UsersService).upsertFromSteamLogin(steamId);
  const effective = (userId: string) => t.app.get(SkinPermissionsService).effectiveFor(userId);

  it('gives a new account level 2 for 60 days, with float editing, and records it in the audit log', async () => {
    const user = await login('76561198000000101');
    const perm = await effective(user.id);
    expect(perm.level).toBe(2);
    expect(perm.floatEditing).toBe(true);
    const row = await t.prisma.skinPermission.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.expiresAt!.getTime() - t.clock.nowMs()).toBeGreaterThan(59.9 * DAY);
    expect(row.expiresAt!.getTime() - t.clock.nowMs()).toBeLessThan(60.1 * DAY);
    expect(await t.prisma.auditLog.count({ where: { action: 'player.skin_level.set', targetId: user.id, actorLabel: 'system' } })).toBe(1);
  });

  it('gives the gift only once, even across logins', async () => {
    const user = await login('76561198000000102');
    await login('76561198000000102');
    await login('76561198000000102');
    expect(await t.prisma.skinPermission.count({ where: { userId: user.id } })).toBe(1);
  });

  it('lets the level run out after 60 days', async () => {
    const user = await login('76561198000000103');
    t.clock.advance(61 * DAY);
    expect((await effective(user.id)).level).toBe(0);
  });

  it('does not touch accounts that already have a skin permission, and can be switched off', async () => {
    const existing = await t.prisma.user.create({ data: { steamId: '76561198000000104', displayName: 'Old' } });
    await t.prisma.skinPermission.create({ data: { userId: existing.id, level: 3, reason: 'manual', expiresAt: null } });
    await login('76561198000000104');
    expect(await t.prisma.skinPermission.count({ where: { userId: existing.id } })).toBe(1);

    await t.app.get(SettingsService).set('skin.welcomeGrant', { enabled: false, level: 2, days: 60, floatEditing: true, stickerCrafts: false }, null);
    const other = await login('76561198000000105');
    expect(await t.prisma.skinPermission.count({ where: { userId: other.id } })).toBe(0);
  });
});
