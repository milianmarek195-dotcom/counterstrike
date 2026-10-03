import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SkinCatalogSource, SkinPriceProvider, type CatalogKeychain, type CatalogSkin } from '../src/skins/skin-catalog.js';
import { SkinSyncService } from '../src/skins/skin-sync.service.js';
import { SkinsModule } from '../src/skins/skins.module.js';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const CATALOG: CatalogSkin[] = [
  { externalId: 's1', weaponDefIndex: 4, weaponClass: 'weapon_glock', weaponName: 'Glock-18', slot: 'PISTOL', paintIndex: 38, name: 'Fade', rarity: null, collection: null, minFloat: 0, maxFloat: 0.08, statTrakAvailable: false, souvenirAvailable: false, imageUrl: null },
  { externalId: 's2', weaponDefIndex: 507, weaponClass: 'weapon_knife_karambit', weaponName: 'Karambit', slot: 'KNIFE', paintIndex: 415, name: 'Doppler', rarity: null, collection: null, minFloat: 0, maxFloat: 0.08, statTrakAvailable: false, souvenirAvailable: false, imageUrl: null },
];
const CHARMS: CatalogKeychain[] = [{ externalId: 'keychain-1', defIndex: 1, name: "Lil' Ava", rarity: 'High Grade', collection: null, imageUrl: null }];

class FakeCatalog extends SkinCatalogSource {
  override async fetchSkins() { return CATALOG; }
  override async fetchStickers() { return []; }
  override async fetchKeychains() { return CHARMS; }
}
class NoPrices extends SkinPriceProvider {
  override readonly name = 'none';
  override async fetchPrices() { return new Map<string, number>(); }
}

describe('charms', () => {
  let t: TestApp;
  let player: TestUser;
  let admin: TestUser;
  beforeAll(async () => {
    t = await createTestApp({ imports: [SkinsModule], customise: (b) => b.overrideProvider(SkinCatalogSource).useValue(new FakeCatalog()).overrideProvider(SkinPriceProvider).useValue(new NoPrices()) });
  });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['owner'] });
    player = await createUser(t);
    await t.app.get(SkinSyncService).syncCatalog();
    await as(t, admin).post('/v1/admin/skins/permissions', { userId: player.id, level: 3, floatEditing: true }).expect(201);
  });

  it('lists charms and attaches one to a weapon, but not to a knife', async () => {
    const list = (await as(t, null).get('/v1/keychains').expect(200)).body;
    expect(list.keychains).toHaveLength(1);
    const charmId = list.keychains[0].id;
    const glock = (await t.prisma.skin.findFirstOrThrow({ where: { weaponDefIndex: 4 } })).id;
    const knife = (await t.prisma.skin.findFirstOrThrow({ where: { weaponDefIndex: 507 } })).id;
    const ok = (await as(t, player).post('/v1/inventory', { slot: 'PISTOL', weaponDefIndex: 4, skinId: glock, floatValue: 0.01, paintSeed: 5, keychainId: charmId, keychainSeed: 77 }).expect(201)).body;
    expect(ok.keychain).toMatchObject({ defIndex: 1 });
    expect(ok.keychainSeed).toBe(77);
    await as(t, player).post('/v1/inventory', { slot: 'KNIFE', weaponDefIndex: 507, skinId: knife, floatValue: 0.01, paintSeed: 1, keychainId: charmId }).expect(400);
  });
});
