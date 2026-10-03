import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SIGNATURE_HEADERS, deriveServerKey, signRequest } from '@celtist/shared/signing';
import { SkinCatalogSource, SkinPriceProvider, type CatalogSkin, type CatalogSticker } from '../src/skins/skin-catalog.js';
import { SkinSyncService } from '../src/skins/skin-sync.service.js';
import { SkinPermissionsService } from '../src/skins/skin-permissions.service.js';
import { SkinsModule } from '../src/skins/skins.module.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const MASTER = 'm'.repeat(48);

const skin = (over: Partial<CatalogSkin>): CatalogSkin => ({
  externalId: 'skin-x', weaponDefIndex: 7, weaponClass: 'weapon_ak47', weaponName: 'AK-47', slot: 'RIFLE', paintIndex: 282, name: 'Redline',
  rarity: 'Classified', collection: 'The Phoenix Collection', minFloat: 0.1, maxFloat: 0.7, statTrakAvailable: true, souvenirAvailable: false, imageUrl: null, ...over,
});
const CATALOG: CatalogSkin[] = [
  skin({}),
  skin({ externalId: 'skin-ch', paintIndex: 44, name: 'Case Hardened', minFloat: 0, maxFloat: 1 }),
  skin({ externalId: 'skin-asi', weaponDefIndex: 9, weaponClass: 'weapon_awp', weaponName: 'AWP', slot: 'AWP', paintIndex: 279, name: 'Asiimov', minFloat: 0.18, maxFloat: 1 }),
  skin({ externalId: 'skin-dl', weaponDefIndex: 9, weaponClass: 'weapon_awp', weaponName: 'AWP', slot: 'AWP', paintIndex: 344, name: 'Dragon Lore', minFloat: 0, maxFloat: 0.7 }),
  skin({ externalId: 'skin-kar', weaponDefIndex: 507, weaponClass: 'weapon_knife_karambit', weaponName: 'Karambit', slot: 'KNIFE', paintIndex: 415, name: 'Doppler', minFloat: 0, maxFloat: 0.08 }),
  skin({ externalId: 'skin-pp', weaponDefIndex: 16, weaponClass: 'weapon_m4a1', weaponName: 'M4A4', slot: 'RIFLE', paintIndex: 255, name: 'Asiimov', minFloat: 0.18, maxFloat: 1 }),
];
const STICKERS: CatalogSticker[] = [
  { externalId: 'sticker-1', defIndex: 1, name: 'Shooter', rarity: null, tournament: 'DreamHack 2013', imageUrl: null },
  { externalId: 'sticker-2', defIndex: 2, name: 'Shooter (Foil)', rarity: null, tournament: 'DreamHack 2013', imageUrl: null },
];

class FakeCatalog extends SkinCatalogSource {
  override async fetchSkins() { return CATALOG; }
  override async fetchStickers() { return STICKERS; }
}

class FakePrices extends SkinPriceProvider {
  override readonly name = 'fake';
  failing = false;
  table = new Map<string, number>([
    ['AK-47 | Redline (Field-Tested)', 25],
    ['AK-47 | Redline (Minimal Wear)', 60],
    ['StatTrak™ AK-47 | Redline (Field-Tested)', 80],
    ['AK-47 | Case Hardened (Field-Tested)', 120],
    ['AWP | Asiimov (Field-Tested)', 70],
    ['AWP | Dragon Lore (Factory New)', 4500],
    ['AWP | Dragon Lore (Field-Tested)', 1600],
    ['★ Karambit | Doppler (Factory New)', 900],
  ]);
  override async fetchPrices(): Promise<Map<string, number>> {
    if (this.failing) throw new Error('provider down');
    return new Map(this.table);
  }
}

describe('skins, inventory, loadouts and skin access', () => {
  let t: TestApp;
  let prices: FakePrices;
  let admin: TestUser;
  let moderator: TestUser;
  let player: TestUser;
  let ids: Record<string, string>;

  beforeAll(async () => {
    prices = new FakePrices();
    t = await createTestApp({
      imports: [SkinsModule],
      customise: (b) => b.overrideProvider(SkinCatalogSource).useValue(new FakeCatalog()).overrideProvider(SkinPriceProvider).useValue(prices),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    prices.failing = false;
    admin = await createUser(t, { roles: ['owner'] });
    moderator = await createUser(t, { roles: ['moderator'] }); // may grant level 1 only
    player = await createUser(t);
    await t.app.get(SkinSyncService).syncCatalog();
    await t.app.get(SkinSyncService).syncPrices();
    const all = await t.prisma.skin.findMany();
    ids = Object.fromEntries(all.map((s) => [`${s.weaponName}|${s.name}`, s.id]));
  });

  const grant = (who: TestUser, body: object) => as(t, who).post('/v1/admin/skins/permissions', { userId: player.id, ...body });
  const item = (over: object = {}) => ({ slot: 'RIFLE', weaponDefIndex: 7, skinId: ids['AK-47|Redline'], floatValue: 0.2, paintSeed: 661, ...over });

  describe('catalog and prices', () => {
    it('builds the skin database from the source instead of hard-coded data', async () => {
      expect(await t.prisma.skin.count()).toBe(6);
      expect(await t.prisma.sticker.count()).toBe(2);
      const redline = await t.prisma.skin.findUniqueOrThrow({ where: { weaponDefIndex_paintIndex: { weaponDefIndex: 7, paintIndex: 282 } } });
      expect(redline).toMatchObject({ weaponName: 'AK-47', name: 'Redline', slot: 'RIFLE', statTrakAvailable: true });
      await t.app.get(SkinSyncService).syncCatalog(); // idempotent
      expect(await t.prisma.skin.count()).toBe(6);
    });

    it('stores prices per wear and variant with a timestamp and keeps the highest on the skin', async () => {
      const redline = await t.prisma.skin.findUniqueOrThrow({ where: { id: ids['AK-47|Redline'] }, include: { prices: true } });
      expect(redline.prices.map((p) => `${p.wear}/${p.variant}/${p.priceUsd}`).sort()).toEqual(['FIELD_TESTED/NORMAL/25', 'FIELD_TESTED/STATTRAK/80', 'MINIMAL_WEAR/NORMAL/60']);
      expect(redline.priceMaxUsd).toBe(80);
      expect(redline.priceUpdatedAt).not.toBeNull();
      expect((await t.prisma.skin.findUniqueOrThrow({ where: { id: ids['M4A4|Asiimov'] } })).priceMaxUsd).toBeNull();
    });

    it('keeps the last known prices when the provider is down, and updates them when it is back', async () => {
      prices.failing = true;
      const failed = await t.app.get(SkinSyncService).syncPrices();
      expect(failed).toMatchObject({ ok: false, matched: 0 });
      expect((await t.prisma.skin.findUniqueOrThrow({ where: { id: ids['AK-47|Redline'] } })).priceMaxUsd).toBe(80);

      prices.failing = false;
      prices.table.set('AK-47 | Redline (Field-Tested)', 30);
      t.clock.advance(3600_000);
      await t.app.get(SkinSyncService).syncPrices();
      const p = await t.prisma.skinPrice.findFirstOrThrow({ where: { skinId: ids['AK-47|Redline'], wear: 'FIELD_TESTED', variant: 'NORMAL' } });
      expect(p.priceUsd).toBe(30);
      expect(p.fetchedAt.getTime()).toBe(t.clock.nowMs());
    });

    it('searches publicly with the level each skin needs', async () => {
      const res = (await as(t, null).get('/v1/skins?q=asiimov').expect(200)).body;
      expect(res.skins.map((s: { weaponName: string }) => s.weaponName).sort()).toEqual(['AWP', 'M4A4']);
      const awp = res.skins.find((s: { weaponName: string }) => s.weaponName === 'AWP');
      expect(awp.requiredLevel).toBe(1); // $70
      const unpriced = res.skins.find((s: { weaponName: string }) => s.weaponName === 'M4A4');
      expect(unpriced.requiredLevel).toBe(3); // no price known: conservative
      expect((await as(t, null).get('/v1/skins?q=dragon').expect(200)).body.skins[0].requiredLevel).toBe(3);
      expect((await as(t, null).get('/v1/skins?slot=KNIFE').expect(200)).body.total).toBe(1);
      const detail = (await as(t, null).get(`/v1/skins/${ids['AWP|Dragon Lore']}`).expect(200)).body;
      expect(detail.prices.map((p: { wear: string; requiredLevel: number }) => [p.wear, p.requiredLevel]).sort()).toEqual([['FACTORY_NEW', 3], ['FIELD_TESTED', 3]]);
      expect((await as(t, null).get('/v1/stickers?q=foil').expect(200)).body.total).toBe(1);
    });
  });

  describe('skin access (levels, temporary grants)', () => {
    it('starts at level 0: nothing can be saved', async () => {
      expect((await as(t, player).get('/v1/skin-access').expect(200)).body).toMatchObject({ level: 0, source: 'default' });
      const res = await as(t, player).post('/v1/inventory', item()).expect(422);
      expect(res.body.error).toBe('ITEM_NOT_ALLOWED');
      expect(res.body.details.map((d: { code: string }) => d.code)).toContain('SKIN_LEVEL_TOO_LOW');
    });

    it('grants by price level: level 1 < $250, level 2 < $1000, level 3 everything', async () => {
      await grant(admin, { level: 1, floatEditing: true }).expect(201);
      await as(t, player).post('/v1/inventory', item()).expect(201); // Redline FT $25
      await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Asiimov'], floatValue: 0.3 })).expect(201); // $70
      await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.01 })).expect(422); // $4500

      await grant(admin, { level: 2, floatEditing: true }).expect(201);
      await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.3 })).expect(422); // FT $1600 > 1000
      await as(t, player).post('/v1/inventory', item({ slot: 'KNIFE', weaponDefIndex: 507, skinId: ids['Karambit|Doppler'], floatValue: 0.01 })).expect(201); // $900

      await grant(admin, { level: 3, floatEditing: true }).expect(201);
      await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.3 })).expect(201);
    });

    it('limits what each admin may hand out by their own permissions', async () => {
      await grant(moderator, { level: 1 }).expect(201);
      const res = await grant(moderator, { level: 2 }).expect(403);
      expect(res.body.error).toBe('SKIN_LEVEL_NOT_ALLOWED');
      await grant(moderator, { level: 3 }).expect(403);
      await grant(player, { level: 1 }).expect(403);
      await grant(null as never, { level: 1 }).expect(401);
      expect((await as(t, admin).get('/v1/admin/skins/permissions').expect(200)).body.maxGrantableLevel).toBe(3);
      expect((await as(t, moderator).get('/v1/admin/skins/permissions').expect(200)).body.maxGrantableLevel).toBe(1);
    });

    it('expires temporary grants at the exact time, without any job', async () => {
      await grant(admin, { level: 3, duration: '2h' }).expect(201);
      expect((await as(t, player).get('/v1/skin-access')).body.level).toBe(3);
      t.clock.advance(2 * 3600_000 - 1000);
      expect((await as(t, player).get('/v1/skin-access')).body.level).toBe(3);
      t.clock.advance(1000);
      expect((await as(t, player).get('/v1/skin-access')).body).toMatchObject({ level: 0, source: 'default' });
    });

    it('supports presets, custom durations and permanent grants', async () => {
      for (const [duration, minutes] of [['15m', 15], ['1h', 60], ['1d', 1440], ['7d', 10080]] as const) {
        await grant(admin, { level: 1, duration }).expect(201);
        const row = await t.prisma.skinPermission.findFirstOrThrow({ where: { userId: player.id, supersededAt: null } });
        expect(row.expiresAt!.getTime() - t.clock.nowMs()).toBe(minutes * 60_000);
      }
      await grant(admin, { level: 1, duration: 'custom', customMinutes: 90 }).expect(201);
      expect((await t.prisma.skinPermission.findFirstOrThrow({ where: { userId: player.id, supersededAt: null } })).expiresAt!.getTime() - t.clock.nowMs()).toBe(90 * 60_000);
      await grant(admin, { level: 1, duration: 'custom' }).expect(400);
      await grant(admin, { level: 2, duration: 'permanent' }).expect(201);
      expect((await t.prisma.skinPermission.findFirstOrThrow({ where: { userId: player.id, supersededAt: null } })).expiresAt).toBeNull();
      await grant(admin, { level: 4 }).expect(400);
    });

    it('stickers, float editing and custom loadouts are separate switches', async () => {
      await grant(admin, { level: 1 }).expect(201);
      const withSticker = item({ stickers: [{ stickerId: (await t.prisma.sticker.findFirstOrThrow()).id, slotIndex: 0, wear: 0 }] });
      expect((await as(t, player).post('/v1/inventory', withSticker).expect(422)).body.details.map((d: { code: string }) => d.code)).toContain('STICKER_CRAFTS_DISABLED');
      expect((await as(t, player).post('/v1/inventory', item({ floatValue: 0.3 })).expect(422)).body.details.map((d: { code: string }) => d.code)).toContain('FLOAT_EDITING_DISABLED');
      await grant(admin, { level: 1, stickerCrafts: true, floatEditing: true }).expect(201);
      await as(t, player).post('/v1/inventory', withSticker).expect(201);
      await as(t, player).post('/v1/inventory', item({ slot: 'RIFLE', weaponDefIndex: 7, skinId: ids['AK-47|Redline'], floatValue: 0.35 })).expect(201);
      await grant(admin, { level: 1, customLoadouts: false }).expect(201);
      expect((await as(t, player).post('/v1/inventory', item()).expect(422)).body.details.map((d: { code: string }) => d.code)).toContain('CUSTOM_LOADOUTS_DISABLED');
    });

    it('writes an audit entry with old value, new value and duration, and revokes cleanly', async () => {
      await grant(admin, { level: 3, duration: '2h', reason: 'tournament' }).expect(201);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'player.skin_level.set' } });
      expect(audit).toMatchObject({ actorId: admin.id, targetId: player.id, reason: 'tournament' });
      expect(audit.oldValue).toMatchObject({ level: 0, source: 'default' });
      expect(audit.newValue).toMatchObject({ level: 3, source: 'grant' });
      expect((audit.newValue as { duration: string }).duration).toBe(new Date(t.clock.nowMs() + 2 * 3600_000).toISOString());
      expect(audit.metadata).toMatchObject({ via: 'web' });

      await as(t, admin).delete(`/v1/admin/skins/permissions/${player.id}?reason=done`).expect(204);
      expect((await as(t, player).get('/v1/skin-access')).body.level).toBe(0);
      expect(await t.prisma.auditLog.count({ where: { action: 'player.skin_level.revoke' } })).toBe(1);
    });

    it('notifies players of grants and, via the job, of expiry', async () => {
      await grant(admin, { level: 2, duration: '15m' }).expect(201);
      expect((await as(t, player).get('/v1/notifications')).body.notifications[0]).toMatchObject({ type: 'skin.permission' });
      t.clock.advance(16 * 60_000);
      expect(await t.app.get(SkinPermissionsService).processExpired()).toBe(1);
      expect(await t.app.get(SkinPermissionsService).processExpired()).toBe(0); // only once
      expect((await as(t, player).get('/v1/notifications')).body.notifications[0]).toMatchObject({ type: 'skin.permission_expired' });
    });
  });

  describe('inventory: float and pattern', () => {
    beforeEach(async () => {
      await grant(admin, { level: 3, stickerCrafts: true, floatEditing: true }).expect(201);
    });

    it('stores weapon, paint kit, float, pattern, StatTrak and stickers', async () => {
      const sticker = await t.prisma.sticker.findFirstOrThrow();
      const res = await as(t, player)
        .post('/v1/inventory', item({ skinId: ids['AK-47|Case Hardened'], floatValue: 0.012345, paintSeed: 661, statTrak: true, statTrakCount: 12, nameTag: 'Blue Gem', stickers: [{ stickerId: sticker.id, slotIndex: 1, wear: 0.1 }] }))
        .expect(201);
      expect(res.body).toMatchObject({ float: 0.012345, pattern: 661, statTrak: true, statTrakCount: 12, nameTag: 'Blue Gem', skin: { name: 'Case Hardened' } });
      expect(res.body.stickers).toHaveLength(1);
      const list = (await as(t, player).get('/v1/inventory').expect(200)).body;
      expect(list.items[0]).toMatchObject({ pattern: 661, float: 0.012345 });
    });

    it.each([[0], [1], [661], [1000]])('accepts pattern %s', async (paintSeed) => {
      await as(t, player).post('/v1/inventory', item({ paintSeed })).expect(201);
    });

    it.each([[661.42], [-1], [1001], ['661'], [null], [Number.NaN]])('rejects the invalid pattern %s', async (paintSeed) => {
      const res = await as(t, player).post('/v1/inventory', item({ paintSeed })).expect(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
    });

    it.each([[0], [0.0001], [0.12], [0.42], [0.999], [1]])('accepts float %s', async (floatValue) => {
      await as(t, player).post('/v1/inventory', item({ floatValue })).expect(201);
    });

    it.each([[-0.0001], [1.0001], [2], ['0.5'], [null]])('rejects the invalid float %s', async (floatValue) => {
      await as(t, player).post('/v1/inventory', item({ floatValue })).expect(400);
    });

    it('rejects impossible combinations', async () => {
      await as(t, player).post('/v1/inventory', item({ statTrak: true, souvenir: true })).expect(400);
      await as(t, player).post('/v1/inventory', item({ souvenir: true })).expect(422); // Redline has no souvenir variant
      await as(t, player).post('/v1/inventory', item({ weaponDefIndex: 9 })).expect(422); // paint kit does not belong to the weapon
      await as(t, player).post('/v1/inventory', item({ skinId: '0199b1f0-0000-7000-8000-0000000000aa' })).expect(404);
      await as(t, player).post('/v1/inventory', item({ nameTag: 'x'.repeat(21) })).expect(400);
      const sticker = (await t.prisma.sticker.findFirstOrThrow()).id;
      await as(t, player).post('/v1/inventory', item({ stickers: [{ stickerId: sticker, slotIndex: 5, wear: 0 }] })).expect(400);
      await as(t, player).post('/v1/inventory', item({ stickers: [{ stickerId: sticker, slotIndex: 0, wear: 0 }, { stickerId: sticker, slotIndex: 0, wear: 0 }] })).expect(400);
    });

    it('edits and deletes only the owner’s own items', async () => {
      const created = (await as(t, player).post('/v1/inventory', item()).expect(201)).body;
      const other = await createUser(t);
      await as(t, other).put(`/v1/inventory/${created.id}`, item({ paintSeed: 1 })).expect(404);
      await as(t, other).delete(`/v1/inventory/${created.id}`).expect(404);
      const edited = (await as(t, player).put(`/v1/inventory/${created.id}`, item({ paintSeed: 151, floatValue: 0.31 })).expect(200)).body;
      expect(edited).toMatchObject({ pattern: 151, float: 0.31 });
      await as(t, player).delete(`/v1/inventory/${created.id}`).expect(204);
      expect((await as(t, player).get('/v1/inventory')).body.items).toHaveLength(0);
    });

    it('lets an admin correct a pattern and audits "from 661 to 151"', async () => {
      const created = (await as(t, player).post('/v1/inventory', item({ paintSeed: 661 })).expect(201)).body;
      await as(t, player).patch(`/v1/admin/skins/inventory/${created.id}`, { pattern: 151 }).expect(403);
      await as(t, admin).patch(`/v1/admin/skins/inventory/${created.id}`, { pattern: 151 }).expect(200);
      await as(t, admin).patch(`/v1/admin/skins/inventory/${created.id}`, { pattern: 1500 }).expect(400);
      const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'player.inventory.edit' } });
      expect(audit).toMatchObject({ actorId: admin.id, oldValue: { pattern: 661 }, newValue: { pattern: 151 } });
    });

    it('limits the inventory size', async () => {
      await t.prisma.platformSetting.update({ where: { key: 'skin.maxInventoryItems' }, data: { value: 2 } });
      t.app.get(SettingsService).invalidate();
      for (let i = 0; i < 2; i++) await as(t, player).post('/v1/inventory', item({ paintSeed: i })).expect(201);
      expect((await as(t, player).post('/v1/inventory', item({ paintSeed: 9 })).expect(409)).body.error).toBe('INVENTORY_FULL');
    });
  });

  describe('loadouts', () => {
    let invItems: Array<{ id: string; weaponDefIndex: number }>;

    beforeEach(async () => {
      await grant(admin, { level: 3, stickerCrafts: true, floatEditing: true }).expect(201);
      invItems = [];
      for (const body of [item({ paintSeed: 661 }), item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Asiimov'], floatValue: 0.21, paintSeed: 12 })]) {
        invItems.push((await as(t, player).post('/v1/inventory', body).expect(201)).body);
      }
    });

    it('allows at most three loadouts, never a fourth', async () => {
      for (const name of ['Main', 'Blue', 'Tournament']) await as(t, player).post('/v1/loadouts', { name }).expect(201);
      const fourth = await as(t, player).post('/v1/loadouts', { name: 'Fourth' }).expect(409);
      expect(fourth.body.error).toBe('LOADOUT_LIMIT_REACHED');
      const list = (await as(t, player).get('/v1/loadouts')).body;
      expect(list.loadouts.map((l: { name: string }) => l.name)).toEqual(['Main', 'Blue', 'Tournament']);
      expect(list.limit).toBe(3);
      // duplicating counts as well, deleting frees a slot
      await as(t, player).post(`/v1/loadouts/${list.loadouts[0].id}/duplicate`).expect(409);
      await as(t, player).delete(`/v1/loadouts/${list.loadouts[2].id}`).expect(204);
      await as(t, player).post(`/v1/loadouts/${list.loadouts[0].id}/duplicate`).expect(201);
      // the hard cap of three cannot be raised: the setting itself rejects values above 3
      await expect(t.app.get(SettingsService).set('skin.maxLoadoutsPerUser', 10, null)).rejects.toMatchObject({ response: { error: 'INVALID_SETTING' } });
    });

    it('makes the first loadout active and keeps exactly one active', async () => {
      const a = (await as(t, player).post('/v1/loadouts', { name: 'A' }).expect(201)).body;
      const b = (await as(t, player).post('/v1/loadouts', { name: 'B' }).expect(201)).body;
      expect(a.isActive).toBe(true);
      expect(b.isActive).toBe(false);
      await as(t, player).post(`/v1/loadouts/${b.id}/activate`).expect(201);
      expect(await t.prisma.loadout.count({ where: { ownerId: player.id, isActive: true } })).toBe(1);
      expect((await t.prisma.loadout.findUniqueOrThrow({ where: { id: b.id } })).isActive).toBe(true);
    });

    it('fills a loadout from inventory items, one per weapon, and only from the owner’s inventory', async () => {
      const loadout = (await as(t, player).post('/v1/loadouts', { name: 'Main' }).expect(201)).body;
      const res = await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: invItems.map((i) => ({ inventoryItemId: i.id })) }).expect(200);
      expect(res.body.items.map((i: { weaponDefIndex: number }) => i.weaponDefIndex)).toEqual([7, 9]);
      expect(res.body.items[0].item).toMatchObject({ pattern: 661 });
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: invItems[0]!.id }, { inventoryItemId: invItems[0]!.id }] }).expect(400);
      const strangerItem = (await as(t, admin).get('/v1/inventory')).body.items[0];
      expect(strangerItem).toBeUndefined();
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: '0199b1f0-0000-7000-8000-0000000000bb' }] }).expect(404);
      const second = (await as(t, player).post(`/v1/loadouts/${loadout.id}/duplicate`).expect(201)).body;
      expect(second.items).toHaveLength(2);
    });

    it('shares by code: view, import into another inventory, export and re-import', async () => {
      const loadout = (await as(t, player).post('/v1/loadouts', { name: 'Shareable' }).expect(201)).body;
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: invItems.map((i) => ({ inventoryItemId: i.id })) }).expect(200);
      expect(loadout.shareCode).toMatch(/^CELTIST-[A-HJ-NP-Z2-9]{6}$/);

      const friend = await createUser(t);
      await as(t, player).patch(`/v1/loadouts/${loadout.id}`, { visibility: 'PRIVATE' }).expect(200);
      await as(t, friend).get(`/v1/loadouts/code/${loadout.shareCode}`).expect(404); // private on request
      await as(t, player).patch(`/v1/loadouts/${loadout.id}`, { visibility: 'UNLISTED' }).expect(200);
      const seen = (await as(t, friend).get(`/v1/loadouts/code/${loadout.shareCode.toLowerCase().replace('-', ' ')}`).expect(200)).body;
      expect(seen).toMatchObject({ name: 'Shareable', items: expect.any(Array) });
      expect(JSON.stringify(seen)).not.toContain(player.id); // no sensitive owner data in the code or the view
      await as(t, friend).get('/v1/loadouts/code/NOT-A-CODE-AT-ALL').expect(400);

      // the friend has level 0: importing works, the report names what they cannot use yet
      const imported = (await as(t, friend).post('/v1/loadouts/import', { code: loadout.shareCode }).expect(201)).body;
      expect(imported.loadout.items).toHaveLength(2);
      expect(imported.restricted).toHaveLength(2);
      expect((await as(t, friend).get('/v1/inventory')).body.items.map((i: { pattern: number }) => i.pattern).sort((a: number, b: number) => a - b)).toEqual([12, 661]);

      const exported = (await as(t, player).get(`/v1/loadouts/${loadout.id}/export`).expect(200)).body;
      expect(exported).toMatchObject({ format: 'celtist-loadout', version: 1, name: 'Shareable' });
      expect(exported.items.map((i: { paintSeed: number; paintIndex: number }) => [i.paintIndex, i.paintSeed]).sort()).toEqual([[279, 12], [282, 661]]);
      expect(JSON.stringify(exported)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7/); // no database ids

      const again = (await as(t, player).post('/v1/loadouts/import-json', { data: { ...exported, name: 'Backup' } }).expect(201)).body;
      expect(again.loadout.items).toHaveLength(2);
      expect(again.skipped).toEqual([]);
      await as(t, player).post('/v1/loadouts/import-json', { data: { ...exported, name: 'Backup 2' } }).expect(201); // the third loadout
      await as(t, player).post('/v1/loadouts/import-json', { data: { ...exported, name: 'Backup 3' } }).expect(409); // a fourth is refused
    });

    it('regenerates share codes so old ones stop working', async () => {
      const loadout = (await as(t, player).post('/v1/loadouts', { name: 'X' }).expect(201)).body;
      await as(t, player).patch(`/v1/loadouts/${loadout.id}`, { visibility: 'PUBLIC' }).expect(200);
      const fresh = (await as(t, player).post(`/v1/loadouts/${loadout.id}/share-code`).expect(201)).body;
      expect(fresh.shareCode).not.toBe(loadout.shareCode);
      await as(t, null).get(`/v1/loadouts/code/${loadout.shareCode}`).expect(404);
      await as(t, null).get(`/v1/loadouts/code/${fresh.shareCode}`).expect(200);
    });

    it('validates imports: unknown skins are skipped and reported, malformed files rejected', async () => {
      const data = { format: 'celtist-loadout', version: 1, name: 'Odd', items: [{ slot: 'RIFLE', weaponDefIndex: 7, paintIndex: 99999, floatValue: 0.1, paintSeed: 5 }] };
      const res = (await as(t, player).post('/v1/loadouts/import-json', { data }).expect(201)).body;
      expect(res.skipped).toEqual([{ weaponDefIndex: 7, reason: 'SKIN_NOT_IN_CATALOG' }]);
      await as(t, player).post('/v1/loadouts/import-json', { data: { ...data, version: 2 } }).expect(400);
      await as(t, player).post('/v1/loadouts/import-json', { data: { ...data, items: [{ ...data.items[0], paintSeed: 661.5 }] } }).expect(400);
    });
  });

  describe('what the game server applies', () => {
    const signed = (serverId: string, method: string, path: string, payload?: object) => {
      const body = payload ? JSON.stringify(payload) : '';
      const timestampMs = t.clock.nowMs();
      const nonce = `n${Math.random().toString(36).slice(2)}${Date.now()}`;
      const req = method === 'GET' ? request(t.app.getHttpServer()).get(path) : request(t.app.getHttpServer()).post(path).set('content-type', 'application/json').send(body);
      return req.set({
        [SIGNATURE_HEADERS.server]: serverId,
        [SIGNATURE_HEADERS.timestamp]: String(timestampMs),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.signature]: signRequest(deriveServerKey(MASTER, serverId, 1), { method, pathWithQuery: path, timestampMs, nonce, body }),
      });
    };
    let serverId: string;

    beforeEach(async () => {
      const server = await t.prisma.server.create({ data: { name: 's', ip: '10.0.0.1', port: 27015, region: 'eu', status: 'READY', lastHeartbeatAt: t.clock.now(), skinsEnabled: true } });
      serverId = server.id;
      await grant(admin, { level: 3, stickerCrafts: true, floatEditing: true, duration: '1h' }).expect(201);
      const awp = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.3, paintSeed: 12 })).expect(201)).body;
      const ak = (await as(t, player).post('/v1/inventory', item({ paintSeed: 661, floatValue: 0.2 })).expect(201)).body;
      const loadout = (await as(t, player).post('/v1/loadouts', { name: 'Main' }).expect(201)).body;
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: awp.id }, { inventoryItemId: ak.id }] }).expect(200);
    });

    it('delivers the active loadout with float and pattern for the plugin', async () => {
      const res = (await signed(serverId, 'GET', `/server/v1/loadouts/${player.steamId}`).expect(200)).body;
      expect(res).toMatchObject({ enabled: true, level: 3 });
      // an item equipped for BOTH sides is delivered once per side
      const ak = res.items.filter((i: { weaponDefIndex: number }) => i.weaponDefIndex === 7);
      expect(ak.map((i: { team: string }) => i.team).sort()).toEqual(['CT', 'T']);
      expect(ak[0]).toMatchObject({ paintIndex: 282, pattern: 661, float: 0.2, statTrak: false });
      expect(res.items).toHaveLength(4);
    });

    it('lets one weapon carry a different skin for T and for CT', async () => {
      const loadout = (await as(t, player).get('/v1/loadouts').expect(200)).body.loadouts[0];
      const asiimov = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Asiimov'], floatValue: 0.4, paintSeed: 5 })).expect(201)).body;
      const lore = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.3, paintSeed: 12 })).expect(201)).body;
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: asiimov.id, team: 'T' }, { inventoryItemId: lore.id, team: 'CT' }] }).expect(200);

      const res = (await signed(serverId, 'GET', `/server/v1/loadouts/${player.steamId}`).expect(200)).body;
      const awps = res.items.filter((i: { weaponDefIndex: number }) => i.weaponDefIndex === 9);
      expect(awps).toHaveLength(2);
      expect(awps.find((i: { team: string }) => i.team === 'T')).toMatchObject({ paintIndex: 279, pattern: 5 });
      expect(awps.find((i: { team: string }) => i.team === 'CT')).toMatchObject({ paintIndex: 344, pattern: 12 });
    });

    it('a side-specific item beats the BOTH item for that side only', async () => {
      const loadout = (await as(t, player).get('/v1/loadouts').expect(200)).body.loadouts[0];
      const both = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Asiimov'], floatValue: 0.4 })).expect(201)).body;
      const lore = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Dragon Lore'], floatValue: 0.3 })).expect(201)).body;
      // BOTH together with a per-side item for the same weapon is refused
      expect((await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: both.id, team: 'BOTH' }, { inventoryItemId: lore.id, team: 'CT' }] }).expect(400)).body.error).toBe('TEAM_CONFLICT');
      // the same weapon twice for one side is refused as well
      expect((await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: both.id, team: 'T' }, { inventoryItemId: lore.id, team: 'T' }] }).expect(400)).body.error).toBe('DUPLICATE_WEAPON');
      // T only: CT gets nothing for the AWP
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: both.id, team: 'T' }] }).expect(200);
      const res = (await signed(serverId, 'GET', `/server/v1/loadouts/${player.steamId}`).expect(200)).body;
      expect(res.items.filter((i: { weaponDefIndex: number }) => i.weaponDefIndex === 9).map((i: { team: string }) => i.team)).toEqual(['T']);
    });

    it('keeps the side when a loadout is duplicated, exported and imported', async () => {
      const loadout = (await as(t, player).get('/v1/loadouts').expect(200)).body.loadouts[0];
      const asiimov = (await as(t, player).post('/v1/inventory', item({ slot: 'AWP', weaponDefIndex: 9, skinId: ids['AWP|Asiimov'], floatValue: 0.4 })).expect(201)).body;
      await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: asiimov.id, team: 'CT' }] }).expect(200);
      const copy = (await as(t, player).post(`/v1/loadouts/${loadout.id}/duplicate`).expect(201)).body;
      expect(copy.items).toMatchObject([{ weaponDefIndex: 9, team: 'CT' }]);
      const exported = (await as(t, player).get(`/v1/loadouts/${loadout.id}/export`).expect(200)).body;
      expect(exported.items[0]).toMatchObject({ weaponDefIndex: 9, team: 'CT' });
    });

    it('drops items the moment the temporary grant ends – without failing', async () => {
      t.clock.advance(61 * 60_000);
      const res = (await signed(serverId, 'GET', `/server/v1/loadouts/${player.steamId}`).expect(200)).body;
      expect(res).toMatchObject({ enabled: true, level: 0, items: [] });
      expect(res.skipped).toHaveLength(4); // two items, once per side
    });

    it('applies nothing on servers where skins are off (the default)', async () => {
      await t.prisma.server.update({ where: { id: serverId }, data: { skinsEnabled: false } });
      expect((await signed(serverId, 'GET', `/server/v1/loadouts/${player.steamId}`).expect(200)).body).toMatchObject({ enabled: false, items: [] });
    });

    it('!skch: the game server forwards, the backend decides who may set which level', async () => {
      const target = await createUser(t);
      const post = (body: object) => signed(serverId, 'POST', '/server/v1/skin-permissions', body).expect(200).then((r) => r.body);

      expect(await post({ actorSteamId: admin.steamId, target: target.steamId, level: 3 })).toMatchObject({ ok: true, players: 1 });
      expect((await as(t, target).get('/v1/skin-access')).body.level).toBe(3);
      expect((await t.prisma.auditLog.findFirstOrThrow({ where: { targetId: target.id, action: 'player.skin_level.set' } })).metadata).toMatchObject({ via: 'ingame' });

      expect(await post({ actorSteamId: moderator.steamId, target: target.steamId, level: 1 })).toMatchObject({ ok: true });
      expect(await post({ actorSteamId: moderator.steamId, target: target.steamId, level: 2 })).toMatchObject({ ok: false, error: 'SKIN_LEVEL_NOT_ALLOWED' });
      expect(await post({ actorSteamId: player.steamId, target: target.steamId, level: 1 })).toMatchObject({ ok: false, error: 'MISSING_PERMISSION' });
      expect(await post({ actorSteamId: '76561198999999998', target: target.steamId, level: 1 })).toMatchObject({ ok: false, error: 'UNKNOWN_ACTOR' });
      expect(await post({ actorSteamId: admin.steamId, target: 'all', level: 2 })).toMatchObject({ ok: false, error: 'NO_MATCH' });
    });
  });
});
