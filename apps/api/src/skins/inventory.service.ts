import { Injectable } from '@nestjs/common';
import type { Prisma } from '@celtist/database';
import {
  DEFAULT_SKIN_LEVEL_THRESHOLDS,
  checkLoadoutItem,
  type EffectiveSkinPermission,
  type InventoryItemInput,
  type LoadoutItemInput,
  type SkinInfo,
} from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SkinPermissionsService } from './skin-permissions.service.js';
import { SkinsService } from './skins.service.js';

const itemInclude = {
  skin: { select: { id: true, name: true, phase: true, weaponName: true, paintIndex: true, imageUrl: true, rarity: true, minFloat: true, maxFloat: true, side: true } },
  stickers: { include: { sticker: { select: { id: true, defIndex: true, name: true, imageUrl: true } } }, orderBy: { slotIndex: 'asc' as const } },
} satisfies Prisma.InventoryItemInclude;

export type InventoryItemRow = Prisma.InventoryItemGetPayload<{ include: typeof itemInclude }>;

/**
 * The virtual inventory: the skins a player saved with their exact configuration (weapon, paint kit, float, pattern,
 * StatTrak/Souvenir, name tag, stickers). Everything is validated server-side against the player's current skin
 * permission; it only ever describes what a controlled game server may display and never touches Steam.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly skins: SkinsService,
    private readonly permissions: SkinPermissionsService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string) {
    const items = await this.prisma.inventoryItem.findMany({ where: { ownerId: userId }, include: itemInclude, orderBy: [{ slot: 'asc' }, { createdAt: 'asc' }] });
    return { items: items.map(toView), limit: await this.settings.get('skin.maxInventoryItems') };
  }

  async get(userId: string, itemId: string): Promise<InventoryItemRow> {
    const item = await this.prisma.inventoryItem.findFirst({ where: { id: itemId, ownerId: userId }, include: itemInclude });
    if (!item) throw notFound('INVENTORY_ITEM_NOT_FOUND', 'Inventory item does not exist');
    return item;
  }

  async create(userId: string, input: InventoryItemInput) {
    const max = await this.settings.get('skin.maxInventoryItems');
    if ((await this.prisma.inventoryItem.count({ where: { ownerId: userId } })) >= max) throw conflict('INVENTORY_FULL', `Your inventory holds at most ${max} items`);
    await this.validate(userId, input);
    const created = await this.prisma.inventoryItem.create({ data: this.data(userId, input), include: itemInclude });
    return toView(created);
  }

  async update(userId: string, itemId: string, input: InventoryItemInput) {
    await this.get(userId, itemId);
    await this.validate(userId, input);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.inventoryItemSticker.deleteMany({ where: { itemId } });
      return tx.inventoryItem.update({ where: { id: itemId }, data: { ...this.data(userId, input), ownerId: undefined }, include: itemInclude });
    });
    return toView(updated);
  }

  async remove(userId: string, itemId: string): Promise<void> {
    await this.get(userId, itemId);
    await this.prisma.inventoryItem.delete({ where: { id: itemId } });
  }

  /** Admin correction of a player's item (e.g. a pattern); every change is audited with old and new value. */
  async adminEdit(itemId: string, patch: { paintSeed?: number; floatValue?: number }, actor: AuditActor, ip?: string | null) {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id: itemId }, include: { owner: { select: { displayName: true } } } });
    if (!item) throw notFound('INVENTORY_ITEM_NOT_FOUND', 'Inventory item does not exist');
    if (patch.paintSeed !== undefined && (!Number.isInteger(patch.paintSeed) || patch.paintSeed < 0 || patch.paintSeed > 1000)) throw badRequest('INVALID_PATTERN', 'The pattern is a whole number from 0 to 1000');
    if (patch.floatValue !== undefined && !(patch.floatValue >= 0 && patch.floatValue <= 1)) throw badRequest('INVALID_FLOAT', 'The float is between 0 and 1');
    const updated = await this.prisma.inventoryItem.update({ where: { id: itemId }, data: { ...(patch.paintSeed !== undefined ? { paintSeed: patch.paintSeed } : {}), ...(patch.floatValue !== undefined ? { floatValue: patch.floatValue } : {}) } });
    await this.audit.record({
      actor,
      action: 'player.inventory.edit',
      targetType: 'inventory_item',
      targetId: itemId,
      targetLabel: item.owner.displayName,
      oldValue: { pattern: item.paintSeed, float: item.floatValue },
      newValue: { pattern: updated.paintSeed, float: updated.floatValue },
      ip,
    });
    return { id: updated.id, pattern: updated.paintSeed, float: updated.floatValue };
  }

  // ─────────────── validation shared with loadouts ───────────────

  /** Rejects the item with a precise list of reasons if it breaks any rule for this player right now. */
  async validate(userId: string, input: InventoryItemInput): Promise<void> {
    const permission = await this.permissions.effectiveFor(userId);
    const infos = input.skinId ? await this.skins.infoFor([input.skinId]) : new Map<string, SkinInfo>();
    const stickerIds = input.stickers.map((s) => s.stickerId);
    if (stickerIds.length > 0 && (await this.prisma.sticker.count({ where: { id: { in: stickerIds } } })) !== new Set(stickerIds).size) throw badRequest('UNKNOWN_STICKER', 'A sticker does not exist');
    if (input.skinId && !infos.has(input.skinId)) throw notFound('SKIN_NOT_FOUND', 'Skin does not exist');
    if (!input.skinId) await this.assertKnownWeapon(input.weaponDefIndex, input.slot);

    const thresholds = await this.settings.get('skin.thresholds');
    const violations = checkLoadoutItem(toRuleItem(input), 0, { skins: infos, permission, thresholds: thresholds ?? DEFAULT_SKIN_LEVEL_THRESHOLDS });
    if (violations.length > 0) throw unprocessable('ITEM_NOT_ALLOWED', 'This configuration is not allowed for you', violations.map((v) => ({ code: v.code, message: v.message })));
  }

  async permissionFor(userId: string): Promise<EffectiveSkinPermission> {
    return this.permissions.effectiveFor(userId);
  }

  private async assertKnownWeapon(weaponDefIndex: number, slot: string): Promise<void> {
    const known = await this.prisma.skin.findFirst({ where: { weaponDefIndex, slot: slot as never }, select: { id: true } });
    if (!known) throw badRequest('UNKNOWN_WEAPON', 'That weapon is not in the catalog');
  }

  private data(userId: string, input: InventoryItemInput): Prisma.InventoryItemUncheckedCreateInput {
    return {
      ownerId: userId,
      slot: input.slot,
      weaponDefIndex: input.weaponDefIndex,
      skinId: input.skinId,
      paintSeed: input.paintSeed,
      floatValue: input.floatValue,
      statTrak: input.statTrak,
      statTrakCount: input.statTrakCount,
      souvenir: input.souvenir,
      nameTag: input.nameTag ?? null,
      stickers: { create: input.stickers.map((s) => ({ stickerId: s.stickerId, slotIndex: s.slotIndex, wear: s.wear, offsetX: s.offsetX ?? null, offsetY: s.offsetY ?? null, rotation: s.rotation ?? null, scale: s.scale ?? null })) },
    };
  }
}

export function toRuleItem(input: InventoryItemInput | InventoryItemRow): LoadoutItemInput {
  return {
    slot: input.slot,
    weaponDefIndex: input.weaponDefIndex,
    skinId: input.skinId ?? null,
    paintSeed: input.paintSeed,
    floatValue: input.floatValue,
    statTrak: input.statTrak,
    statTrakCount: input.statTrakCount,
    souvenir: input.souvenir,
    nameTag: input.nameTag ?? null,
    stickers: input.stickers.map((s) => ({ slotIndex: s.slotIndex, stickerId: 'stickerId' in s ? s.stickerId : (s as { sticker: { id: string } }).sticker.id, wear: s.wear })),
  };
}

export function toView(item: InventoryItemRow) {
  return {
    id: item.id,
    slot: item.slot,
    weaponDefIndex: item.weaponDefIndex,
    skin: item.skin,
    float: item.floatValue,
    pattern: item.paintSeed,
    statTrak: item.statTrak,
    statTrakCount: item.statTrakCount,
    souvenir: item.souvenir,
    nameTag: item.nameTag,
    stickers: item.stickers.map((s) => ({ slotIndex: s.slotIndex, wear: s.wear, sticker: s.sticker, offsetX: s.offsetX, offsetY: s.offsetY, rotation: s.rotation, scale: s.scale })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
