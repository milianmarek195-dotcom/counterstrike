import { Injectable } from '@nestjs/common';
import { Prisma, isUniqueViolation } from '@celtist/database';
import {
  checkLoadoutItem,
  generateShareCode,
  normalizeShareCode,
  resolveLoadoutForApplication,
  type InventoryItemInput,
  type LoadoutExport,
} from '@celtist/shared';
import { randomBytes } from 'node:crypto';
import { badRequest, conflict, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InventoryService, toRuleItem, toView } from './inventory.service.js';
import { SkinPermissionsService } from './skin-permissions.service.js';
import { SkinsService } from './skins.service.js';

/** Hard product rule: three loadouts per player at most, whatever the setting says. */
export const MAX_LOADOUTS = 3;

const loadoutInclude = {
  items: {
    include: {
      inventoryItem: {
        include: {
          skin: { select: { id: true, name: true, phase: true, weaponName: true, paintIndex: true, imageUrl: true, rarity: true, minFloat: true, maxFloat: true, side: true, modelPath: true, legacyModel: true } },
          stickers: { include: { sticker: { select: { id: true, defIndex: true, name: true, imageUrl: true } } }, orderBy: { slotIndex: 'asc' as const } },
          keychain: { select: { id: true, defIndex: true, name: true, imageUrl: true, rarity: true } },
        },
      },
    },
    orderBy: { weaponDefIndex: 'asc' as const },
  },
} satisfies Prisma.LoadoutInclude;
type LoadoutRow = Prisma.LoadoutGetPayload<{ include: typeof loadoutInclude }>;

const view = (l: LoadoutRow, owner?: { displayName: string }) => ({
  id: l.id,
  name: l.name,
  shareCode: l.shareCode,
  visibility: l.visibility,
  isActive: l.isActive,
  activeT: l.activeT,
  activeCt: l.activeCt,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
  ...(owner ? { owner: owner.displayName } : {}),
  items: l.items.map((i) => ({ weaponDefIndex: i.weaponDefIndex, team: i.team, item: toView(i.inventoryItem) })),
});

@Injectable()
export class LoadoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
    private readonly skins: SkinsService,
    private readonly permissions: SkinPermissionsService,
  ) {}

  /** The active loadout of a player as other people see it (only when its owner left it public). */
  async publicActive(steamId: string) {
    const user = await this.prisma.user.findUnique({ where: { steamId }, select: { id: true, displayName: true } });
    if (!user) throw notFound('USER_NOT_FOUND', 'Player does not exist');
    const loadout = await this.prisma.loadout.findFirst({ where: { ownerId: user.id, isActive: true, visibility: 'PUBLIC' }, include: loadoutInclude });
    if (!loadout) return { loadout: null };
    const { shareCode: _code, ...rest } = view(loadout, user);
    return { loadout: rest };
  }

  async list(userId: string) {
    const loadouts = await this.prisma.loadout.findMany({ where: { ownerId: userId }, include: loadoutInclude, orderBy: { createdAt: 'asc' } });
    return { loadouts: loadouts.map((l) => view(l)), limit: await this.limit() };
  }

  async create(userId: string, name: string) {
    const loadout = await this.createRow(userId, name);
    return view(await this.load(userId, loadout.id));
  }

  async update(userId: string, id: string, patch: { name?: string; visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC' }) {
    await this.load(userId, id);
    await this.prisma.loadout.update({ where: { id }, data: { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}) } });
    return view(await this.load(userId, id));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.load(userId, id);
    await this.prisma.loadout.delete({ where: { id } });
  }

  /** Copies a loadout (counts toward the limit of three). Items are shared references to the same inventory items. */
  async duplicate(userId: string, id: string) {
    const source = await this.load(userId, id);
    const copy = await this.createRow(userId, `${source.name} copy`.slice(0, 40), false);
    await this.prisma.loadoutItem.createMany({ data: source.items.map((i) => ({ loadoutId: copy.id, inventoryItemId: i.inventoryItemId, weaponDefIndex: i.weaponDefIndex, team: i.team })) });
    return view(await this.load(userId, copy.id));
  }

  /**
   * Chooses the inventory item for each weapon and side; replaces the previous selection. A weapon may carry one item
   * for T and a different one for CT, or a single item for BOTH sides (never BOTH together with a per-side item).
   */
  async setItems(userId: string, id: string, items: Array<{ inventoryItemId: string; team?: 'BOTH' | 'T' | 'CT' }>) {
    await this.load(userId, id);
    const ids = items.map((i) => i.inventoryItemId);
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_ITEM', 'An inventory item can only be used once per loadout');
    const owned = await this.prisma.inventoryItem.findMany({ where: { id: { in: ids }, ownerId: userId }, include: { skin: { select: { side: true } } } });
    if (owned.length !== ids.length) throw notFound('INVENTORY_ITEM_NOT_FOUND', 'One of the items is not in your inventory');
    const byId = new Map(owned.map((o) => [o.id, o] as const));
    const rows = items.map((i) => {
      const o = byId.get(i.inventoryItemId)!;
      // an agent only exists for its own side
      const team = o.slot === 'AGENT' ? ((o.skin?.side as 'T' | 'CT' | null) ?? 'T') : (i.team ?? ('BOTH' as const));
      return { loadoutId: id, inventoryItemId: i.inventoryItemId, weaponDefIndex: o.weaponDefIndex, team, agent: o.slot === 'AGENT' };
    });
    this.assertTeamSlots(rows);
    this.assertOneAgentPerSide(rows);

    await this.prisma.$transaction(async (tx) => {
      await tx.loadoutItem.deleteMany({ where: { loadoutId: id } });
      await tx.loadoutItem.createMany({ data: rows.map(({ agent: _agent, ...r }) => r) });
      // Only starred skins are kept permanently: an item that is in no loadout any more and has no star is dropped
      await tx.inventoryItem.deleteMany({ where: { ownerId: userId, favorite: false, loadoutItems: { none: {} } } });
    });
    return view(await this.load(userId, id));
  }

  private assertOneAgentPerSide(rows: ReadonlyArray<{ agent: boolean; team: 'BOTH' | 'T' | 'CT' }>): void {
    const sides = rows.filter((r) => r.agent).map((r) => r.team);
    if (new Set(sides).size !== sides.length) throw badRequest('DUPLICATE_AGENT', 'Only one agent per side can be equipped');
  }

  /** One item per weapon and side; BOTH cannot coexist with T or CT for the same weapon. */
  private assertTeamSlots(rows: ReadonlyArray<{ weaponDefIndex: number; team: 'BOTH' | 'T' | 'CT' }>): void {
    const sides = new Map<number, Set<string>>();
    for (const r of rows) {
      const set = sides.get(r.weaponDefIndex) ?? new Set<string>();
      if (set.has(r.team)) throw badRequest('DUPLICATE_WEAPON', 'A loadout holds one item per weapon and side');
      set.add(r.team);
      sides.set(r.weaponDefIndex, set);
    }
    for (const set of sides.values()) {
      if (set.has('BOTH') && set.size > 1) throw badRequest('TEAM_CONFLICT', 'A weapon is either equipped for both sides or per side, not both');
    }
  }

  /** The active loadout is the one a server applies; exactly one at most (database enforced). */
  async activate(userId: string, id: string) {
    await this.load(userId, id);
    await this.prisma.$transaction([
      this.prisma.loadout.updateMany({ where: { ownerId: userId, isActive: true }, data: { isActive: false } }),
      this.prisma.loadout.update({ where: { id }, data: { isActive: true } }),
    ]);
    return view(await this.load(userId, id));
  }

  /** Makes a loadout the one that applies on a single side (T or CT), on top of the default active loadout; or removes that. */
  async setSide(userId: string, id: string, side: 'T' | 'CT', active: boolean) {
    await this.load(userId, id);
    const field = side === 'T' ? 'activeT' : 'activeCt';
    await this.prisma.$transaction([
      ...(active ? [this.prisma.loadout.updateMany({ where: { ownerId: userId, [field]: true }, data: { [field]: false } })] : []),
      this.prisma.loadout.update({ where: { id }, data: { [field]: active } }),
    ]);
    return view(await this.load(userId, id));
  }

  async regenerateCode(userId: string, id: string) {
    await this.load(userId, id);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.prisma.loadout.update({ where: { id }, data: { shareCode: generateShareCode((n) => randomBytes(n)) } });
        return view(await this.load(userId, id));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw conflict('CODE_GENERATION_FAILED', 'Could not generate a unique share code, try again');
  }

  // ─────────────── sharing ───────────────

  /** Read-only look at a shared loadout (private ones are invisible to everyone but the owner). */
  async byCode(code: string, viewerId?: string) {
    const normalised = normalizeShareCode(code);
    if (!normalised) throw badRequest('INVALID_SHARE_CODE', 'That is not a valid share code');
    const loadout = await this.prisma.loadout.findUnique({ where: { shareCode: normalised }, include: { ...loadoutInclude, owner: { select: { id: true, displayName: true } } } });
    if (!loadout || (loadout.visibility === 'PRIVATE' && loadout.ownerId !== viewerId)) throw notFound('LOADOUT_NOT_FOUND', 'No loadout with that code');
    return view(loadout, loadout.owner);
  }

  /** Imports a shared loadout: its items are copied into the importer's inventory and a new loadout is created. */
  async importByCode(userId: string, code: string, name?: string) {
    const normalised = normalizeShareCode(code);
    if (!normalised) throw badRequest('INVALID_SHARE_CODE', 'That is not a valid share code');
    const source = await this.prisma.loadout.findUnique({ where: { shareCode: normalised }, include: loadoutInclude });
    if (!source || (source.visibility === 'PRIVATE' && source.ownerId !== userId)) throw notFound('LOADOUT_NOT_FOUND', 'No loadout with that code');

    const inventoryMax = await this.settings.get('skin.maxInventoryItems');
    const used = await this.prisma.inventoryItem.count({ where: { ownerId: userId } });
    if (used + source.items.length > inventoryMax) throw conflict('INVENTORY_FULL', `Importing needs ${source.items.length} free inventory slots (you have ${inventoryMax - used})`);

    const loadout = await this.createRow(userId, (name ?? source.name).slice(0, 40), false);
    const restricted = await this.copyItems(userId, loadout.id, source.items.map((i) => ({ source: i.inventoryItem as never, team: i.team })));
    return { loadout: view(await this.load(userId, loadout.id)), restricted };
  }

  /** Portable JSON (no database ids). */
  async export(userId: string, id: string): Promise<LoadoutExport> {
    const loadout = await this.load(userId, id);
    return {
      format: 'celtist-loadout',
      version: 1,
      name: loadout.name,
      items: loadout.items.map(({ inventoryItem: i, team }) => ({
        slot: i.slot,
        weaponDefIndex: i.weaponDefIndex,
        team,
        paintIndex: i.skin?.paintIndex ?? null,
        floatValue: i.floatValue,
        paintSeed: i.paintSeed,
        statTrak: i.statTrak,
        statTrakCount: i.statTrakCount,
        souvenir: i.souvenir,
        nameTag: i.nameTag,
        stickers: i.stickers.map((s) => ({ stickerDefIndex: s.sticker.defIndex, slotIndex: s.slotIndex, wear: s.wear, offsetX: s.offsetX, offsetY: s.offsetY, rotation: s.rotation, scale: s.scale })),
      })),
    };
  }

  async importJson(userId: string, data: LoadoutExport) {
    const inventoryMax = await this.settings.get('skin.maxInventoryItems');
    const used = await this.prisma.inventoryItem.count({ where: { ownerId: userId } });
    if (used + data.items.length > inventoryMax) throw conflict('INVENTORY_FULL', 'Not enough free inventory slots');
    const loadout = await this.createRow(userId, data.name, false);

    const skipped: Array<{ weaponDefIndex: number; reason: string }> = [];
    const created: Array<{ id: string; weaponDefIndex: number; team: 'BOTH' | 'T' | 'CT' }> = [];
    for (const item of data.items) {
      const skin = item.paintIndex === null ? null : await this.prisma.skin.findUnique({ where: { weaponDefIndex_paintIndex: { weaponDefIndex: item.weaponDefIndex, paintIndex: item.paintIndex } } });
      if (item.paintIndex !== null && !skin) {
        skipped.push({ weaponDefIndex: item.weaponDefIndex, reason: 'SKIN_NOT_IN_CATALOG' });
        continue;
      }
      const stickers = await this.prisma.sticker.findMany({ where: { defIndex: { in: item.stickers.map((s) => s.stickerDefIndex) } } });
      const byDef = new Map(stickers.map((s) => [s.defIndex, s.id] as const));
      const row = await this.prisma.inventoryItem.create({
        data: {
          ownerId: userId,
          slot: item.slot,
          weaponDefIndex: item.weaponDefIndex,
          skinId: skin?.id ?? null,
          paintSeed: item.paintSeed,
          floatValue: item.floatValue,
          statTrak: item.statTrak,
          statTrakCount: item.statTrakCount,
          souvenir: item.souvenir,
          nameTag: item.nameTag,
          stickers: { create: item.stickers.filter((s) => byDef.has(s.stickerDefIndex)).map((s) => ({ stickerId: byDef.get(s.stickerDefIndex)!, slotIndex: s.slotIndex, wear: s.wear, offsetX: s.offsetX ?? null, offsetY: s.offsetY ?? null, rotation: s.rotation ?? null, scale: s.scale ?? null })) },
        },
      });
      created.push({ id: row.id, weaponDefIndex: row.weaponDefIndex, team: item.team });
    }
    // keep the first item per weapon and side; an entry for BOTH sides wins over per-side entries of the same weapon
    const bothWeapons = new Set(created.filter((c) => c.team === 'BOTH').map((c) => c.weaponDefIndex));
    const seen = new Set<string>();
    const unique = created.filter((c) => {
      if (c.team !== 'BOTH' && bothWeapons.has(c.weaponDefIndex)) return false;
      const key = `${c.weaponDefIndex}:${c.team}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await this.prisma.loadoutItem.createMany({ data: unique.map((c) => ({ loadoutId: loadout.id, inventoryItemId: c.id, weaponDefIndex: c.weaponDefIndex, team: c.team })) });
    return { loadout: view(await this.load(userId, loadout.id)), skipped };
  }

  // ─────────────── what a game server applies ───────────────

  /**
   * The player's active loadout, filtered by their permission AT THIS MOMENT: an expired grant simply yields fewer (or no)
   * items instead of an error, so a match is never disturbed by permission changes.
   */
  async resolveForServer(steamId: string) {
    const user = await this.prisma.user.findUnique({ where: { steamId }, select: { id: true } });
    if (!user) return { level: 0, items: [], skipped: [] };
    // each side uses the loadout made active for it, otherwise the default active loadout
    const candidates = await this.prisma.loadout.findMany({ where: { ownerId: user.id, OR: [{ isActive: true }, { activeT: true }, { activeCt: true }] }, include: loadoutInclude });
    const permission = await this.permissions.effectiveFor(user.id);
    if (candidates.length === 0) return { level: permission.level, items: [], skipped: [] };
    const loadoutFor = (side: 'T' | 'CT') => candidates.find((c) => (side === 'T' ? c.activeT : c.activeCt)) ?? candidates.find((c) => c.isActive);

    const infos = await this.skins.infoFor(candidates.flatMap((c) => c.items.flatMap((i) => (i.inventoryItem.skinId ? [i.inventoryItem.skinId] : []))));
    const thresholds = await this.settings.get('skin.thresholds');

    // Resolve each side on its own: the same weapon may carry different skins for T and CT. An item equipped for BOTH
    // counts for each side unless that side has an item of its own.
    const items: Array<Record<string, unknown>> = [];
    const skipped: Array<{ team: string; weaponDefIndex: number; reasons: string[] }> = [];
    for (const side of ['T', 'CT'] as const) {
      const loadout = loadoutFor(side);
      if (!loadout) continue;
      const chosen = new Map<number, (typeof loadout.items)[number]>();
      for (const li of loadout.items) if (li.team === 'BOTH') chosen.set(li.weaponDefIndex, li);
      for (const li of loadout.items) if (li.team === side) chosen.set(li.weaponDefIndex, li);
      const rows = [...chosen.values()];
      const applied = resolveLoadoutForApplication(rows.map((r) => toRuleItem(r.inventoryItem as never)), { skins: infos, permission, thresholds });
      const byWeapon = new Map(rows.map((r) => [r.weaponDefIndex, r.inventoryItem] as const));
      for (const it of applied.items) {
        const row = byWeapon.get(it.weaponDefIndex)!;
        items.push({
          team: side,
          weaponDefIndex: it.weaponDefIndex,
          slot: it.slot,
          paintIndex: row.skin?.paintIndex ?? 0,
          pattern: it.paintSeed,
          float: it.floatValue,
          statTrak: it.statTrak,
          statTrakCount: it.statTrakCount,
          souvenir: it.souvenir,
          nameTag: it.nameTag,
          modelPath: row.skin?.modelPath ?? null,
          legacyModel: row.skin?.legacyModel ?? false,
          keychain: row.keychain ? { defIndex: row.keychain.defIndex, seed: row.keychainSeed, offsetX: row.keychainOffsetX, offsetY: row.keychainOffsetY, offsetZ: row.keychainOffsetZ } : null,
          stickers: row.stickers.map((st) => ({ slot: st.slotIndex, defIndex: st.sticker.defIndex, wear: st.wear, offsetX: st.offsetX ?? 0, offsetY: st.offsetY ?? 0, rotation: st.rotation ?? 0, scale: st.scale ?? 1 })),
        });
      }
      for (const sk of applied.skipped) skipped.push({ team: side, weaponDefIndex: sk.weaponDefIndex, reasons: sk.reasons as string[] });
    }
    return { level: permission.level, items, skipped };
  }

  // ─────────────── internals ───────────────

  private async limit(): Promise<number> {
    return Math.min(MAX_LOADOUTS, await this.settings.get('skin.maxLoadoutsPerUser'));
  }

  private async createRow(userId: string, name: string, activateFirst = true) {
    const limit = await this.limit();
    const existing = await this.prisma.loadout.count({ where: { ownerId: userId } });
    if (existing >= limit) throw conflict('LOADOUT_LIMIT_REACHED', `You can have at most ${limit} loadouts`);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.prisma.loadout.create({ data: { ownerId: userId, name, shareCode: generateShareCode((n) => randomBytes(n)), isActive: activateFirst && existing === 0 } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (/ownerId/i.test(JSON.stringify((error as { meta?: unknown }).meta ?? ''))) throw conflict('LOADOUT_CONFLICT', 'Conflicting loadout state, try again');
      }
    }
    throw conflict('CODE_GENERATION_FAILED', 'Could not generate a unique share code, try again');
  }

  private async load(userId: string, id: string): Promise<LoadoutRow> {
    const loadout = await this.prisma.loadout.findFirst({ where: { id, ownerId: userId }, include: loadoutInclude });
    if (!loadout) throw notFound('LOADOUT_NOT_FOUND', 'Loadout does not exist');
    return loadout;
  }

  /** Copies someone else's inventory items into the importer's inventory; reports what the importer's level does not allow. */
  private async copyItems(userId: string, loadoutId: string, entries: Array<{ source: Parameters<typeof toRuleItem>[0] & { skin: { id: string } | null }; team: 'BOTH' | 'T' | 'CT' }>) {
    const sources = entries.map((e) => e.source);
    const permission = await this.permissions.effectiveFor(userId);
    const infos = await this.skins.infoFor(sources.flatMap((s) => (s.skinId ? [s.skinId] : [])));
    const thresholds = await this.settings.get('skin.thresholds');
    const restricted: Array<{ weaponDefIndex: number; reasons: string[] }> = [];
    for (const [index, source] of sources.entries()) {
      const item = source as unknown as { stickers: Array<{ sticker: { id: string }; slotIndex: number; wear: number; offsetX: number | null; offsetY: number | null; rotation: number | null; scale: number | null }> };
      const violations = checkLoadoutItem(toRuleItem(source), 0, { skins: infos, permission, thresholds });
      if (violations.length > 0) restricted.push({ weaponDefIndex: source.weaponDefIndex, reasons: violations.map((v) => v.code) });
      const row = await this.prisma.inventoryItem.create({
        data: {
          ownerId: userId,
          slot: source.slot,
          weaponDefIndex: source.weaponDefIndex,
          skinId: source.skinId ?? null,
          paintSeed: source.paintSeed,
          floatValue: source.floatValue,
          statTrak: source.statTrak,
          statTrakCount: source.statTrakCount,
          souvenir: source.souvenir,
          nameTag: source.nameTag ?? null,
          keychainId: source.keychainId ?? null,
          keychainSeed: source.keychainSeed ?? 0,
          keychainOffsetX: source.keychainOffsetX ?? 0,
          keychainOffsetY: source.keychainOffsetY ?? 0,
          keychainOffsetZ: source.keychainOffsetZ ?? 0,
          stickers: { create: item.stickers.map((s) => ({ stickerId: s.sticker.id, slotIndex: s.slotIndex, wear: s.wear, offsetX: s.offsetX, offsetY: s.offsetY, rotation: s.rotation, scale: s.scale })) },
        },
      });
      await this.prisma.loadoutItem.create({ data: { loadoutId, inventoryItemId: row.id, weaponDefIndex: row.weaponDefIndex, team: entries[index]!.team } });
    }
    return restricted;
  }
}
