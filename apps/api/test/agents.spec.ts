import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SkinCatalogSource, SkinPriceProvider, type CatalogSkin } from '../src/skins/skin-catalog.js';
import { SkinSyncService } from '../src/skins/skin-sync.service.js';
import { SkinsModule } from '../src/skins/skins.module.js';
import { as, createUser, type TestUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const agent = (over: Partial<CatalogSkin>): CatalogSkin => ({
  externalId: 'agent-1', weaponDefIndex: 4613, weaponClass: 'agent', weaponName: 'Bloody Darryl The Strapped | The Professionals', slot: 'AGENT', paintIndex: 0, name: '',
  rarity: 'Superior', collection: null, minFloat: 0, maxFloat: 1, statTrakAvailable: false, souvenirAvailable: false, imageUrl: null,
  modelPath: 'characters/models/tm_professional/tm_professional_varf5.vmdl', side: 'T', ...over,
});
const CATALOG: CatalogSkin[] = [
  agent({}),
  agent({ externalId: 'agent-2', weaponDefIndex: 4619, weaponName: 'Buckshot | NSWC SEAL', modelPath: 'characters/models/ctm_st6/ctm_st6_variantk.vmdl', side: 'CT' }),
  agent({ externalId: 'agent-3', weaponDefIndex: 4620, weaponName: 'Second T Agent', modelPath: 'characters/models/tm_leet/tm_leet_variantg.vmdl', side: 'T' }),
];
class FakeCatalog extends SkinCatalogSource {
  override async fetchSkins() { return CATALOG; }
  override async fetchStickers() { return []; }
}
class FakePrices extends SkinPriceProvider {
  override readonly name = 'fake';
  override async fetchPrices() { return new Map<string, number>([['Bloody Darryl The Strapped | The Professionals', 6]]); }
}

describe('agents in the skin changer', () => {
  let t: TestApp;
  let admin: TestUser;
  let player: TestUser;
  let ids: Record<number, string>;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [SkinsModule],
      customise: (b) => b.overrideProvider(SkinCatalogSource).useValue(new FakeCatalog()).overrideProvider(SkinPriceProvider).useValue(new FakePrices()),
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await createUser(t, { roles: ['owner'] });
    player = await createUser(t);
    await t.app.get(SkinSyncService).syncCatalog();
    await t.app.get(SkinSyncService).syncPrices();
    ids = Object.fromEntries((await t.prisma.skin.findMany()).map((s) => [s.weaponDefIndex, s.id]));
    await as(t, admin).post('/v1/admin/skins/permissions', { userId: player.id, level: 3 }).expect(201);
  });

  const owned = async (def: number) =>
    (await as(t, player).post('/v1/inventory', { slot: 'AGENT', weaponDefIndex: def, skinId: ids[def], floatValue: 0.001, paintSeed: 1 }).expect(201)).body;

  it('stores model and side in the catalog and prices agents by their plain market name', async () => {
    const a = await t.prisma.skin.findUniqueOrThrow({ where: { id: ids[4613]! } });
    expect(a).toMatchObject({ slot: 'AGENT', side: 'T', modelPath: 'characters/models/tm_professional/tm_professional_varf5.vmdl', priceMaxUsd: 6 });
    expect((await as(t, null).get('/v1/skins?slot=AGENT').expect(200)).body.total).toBe(3);
  });

  it('puts an agent on its own side only and delivers the model path to the server', async () => {
    const t1 = await owned(4613);
    const ct = await owned(4619);
    const loadout = (await as(t, player).post('/v1/loadouts', { name: 'A' }).expect(201)).body;
    // the requested side is ignored: an agent belongs to the side it was made for
    const res = (await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: t1.id, team: 'BOTH' }, { inventoryItemId: ct.id, team: 'T' }] }).expect(200)).body;
    expect(res.items.map((i: { team: string }) => i.team).sort()).toEqual(['CT', 'T']);

    const view = res;
    expect(view.items).toHaveLength(2);
  });

  it('refuses two agents for the same side', async () => {
    const a = await owned(4613);
    const b = await owned(4620);
    const loadout = (await as(t, player).post('/v1/loadouts', { name: 'A' }).expect(201)).body;
    expect((await as(t, player).put(`/v1/loadouts/${loadout.id}/items`, { items: [{ inventoryItemId: a.id }, { inventoryItemId: b.id }] }).expect(400)).body.error).toBe('DUPLICATE_AGENT');
  });
});
