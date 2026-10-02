import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '@celtist/database';
import {
  validateVetoShape,
  type BestOf,
  type CreateMapInput,
  type CreateMapPoolInput,
  type CreateVetoTemplateInput,
  type GameMode,
  type UpdateMapInput,
} from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const CACHE_PREFIX = 'maps:';
const CACHE_TTL = 60;

@Injectable()
export class MapsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── reads (public, cached) ─────────────

  listMaps(mode?: GameMode, includeInactive = false) {
    return this.redis.remember(`${CACHE_PREFIX}list:${mode ?? 'all'}:${includeInactive}`, CACHE_TTL, () =>
      this.prisma.gameMap.findMany({
        where: { ...(includeInactive ? {} : { active: true }), ...(mode ? { modes: { has: mode } } : {}) },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  listPools() {
    return this.redis.remember(`${CACHE_PREFIX}pools`, CACHE_TTL, async () => {
      const pools = await this.prisma.mapPool.findMany({
        include: { maps: { include: { map: true }, orderBy: { position: 'asc' } } },
        orderBy: { name: 'asc' },
      });
      return pools.map((pool) => ({
        id: pool.id,
        name: pool.name,
        mode: pool.mode,
        isDefault: pool.isDefault,
        maps: pool.maps.map((entry) => entry.map),
      }));
    });
  }

  listVetoTemplates() {
    return this.prisma.vetoTemplate.findMany({ orderBy: [{ bestOf: 'asc' }, { name: 'asc' }] });
  }

  async poolOrThrow(poolId: string) {
    const pool = await this.prisma.mapPool.findUnique({
      where: { id: poolId },
      include: { maps: { include: { map: true }, orderBy: { position: 'asc' } } },
    });
    if (!pool) throw notFound('MAP_POOL_NOT_FOUND', 'Map pool does not exist');
    return pool;
  }

  /** The default pool for a mode (falls back to any pool of that mode). */
  async defaultPoolFor(mode: GameMode) {
    const pool =
      (await this.prisma.mapPool.findFirst({ where: { mode, isDefault: true } })) ??
      (await this.prisma.mapPool.findFirst({ where: { mode } }));
    if (!pool) throw notFound('MAP_POOL_NOT_FOUND', `No map pool exists for ${mode}`);
    return this.poolOrThrow(pool.id);
  }

  // ───────────── maps ─────────────

  async createMap(input: CreateMapInput, actor: AuditActor, ip?: string | null) {
    try {
      const map = await this.prisma.gameMap.create({
        data: {
          key: input.key,
          name: input.name,
          imageUrl: input.imageUrl ?? null,
          workshopId: input.workshopId ?? null,
          modes: input.modes,
          active: input.active,
          position: input.position,
        },
      });
      await this.audit.record({ actor, action: 'map.create', targetType: 'map', targetId: map.id, targetLabel: map.name, newValue: map, ip });
      await this.invalidate();
      return map;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('MAP_KEY_TAKEN', `A map with the key "${input.key}" already exists`);
      throw error;
    }
  }

  async updateMap(id: string, input: UpdateMapInput, actor: AuditActor, ip?: string | null) {
    const before = await this.prisma.gameMap.findUnique({ where: { id } });
    if (!before) throw notFound('MAP_NOT_FOUND', 'Map does not exist');
    const map = await this.prisma.gameMap.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.imageUrl !== undefined ? { imageUrl: input.imageUrl } : {}),
        ...(input.workshopId !== undefined ? { workshopId: input.workshopId } : {}),
        ...(input.modes !== undefined ? { modes: input.modes } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
      },
    });
    await this.audit.record({ actor, action: 'map.update', targetType: 'map', targetId: id, targetLabel: map.name, oldValue: before, newValue: map, ip });
    await this.invalidate();
    return map;
  }

  async deleteMap(id: string, actor: AuditActor, ip?: string | null): Promise<void> {
    const before = await this.prisma.gameMap.findUnique({ where: { id } });
    if (!before) throw notFound('MAP_NOT_FOUND', 'Map does not exist');
    const [inPools, inMatches] = await Promise.all([
      this.prisma.mapPoolMap.count({ where: { mapId: id } }),
      this.prisma.matchMap.count({ where: { mapId: id } }),
    ]);
    if (inPools > 0 || inMatches > 0) {
      throw conflict('MAP_IN_USE', 'This map is used by map pools or matches; deactivate it instead of deleting it');
    }
    await this.prisma.gameMap.delete({ where: { id } });
    await this.audit.record({ actor, action: 'map.delete', targetType: 'map', targetId: id, targetLabel: before.name, oldValue: before, ip });
    await this.invalidate();
  }

  // ───────────── pools ─────────────

  async createPool(input: CreateMapPoolInput, actor: AuditActor, ip?: string | null) {
    await this.assertPoolMaps(input.mapIds, input.mode ?? null);
    try {
      const pool = await this.prisma.$transaction(async (tx) => {
        if (input.isDefault && input.mode) await tx.mapPool.updateMany({ where: { mode: input.mode, isDefault: true }, data: { isDefault: false } });
        return tx.mapPool.create({
          data: {
            name: input.name,
            mode: input.mode ?? null,
            isDefault: input.isDefault,
            maps: { create: input.mapIds.map((mapId, position) => ({ mapId, position })) },
          },
        });
      });
      await this.audit.record({ actor, action: 'map_pool.create', targetType: 'map_pool', targetId: pool.id, targetLabel: pool.name, newValue: { ...input }, ip });
      await this.invalidate();
      return this.poolOrThrow(pool.id);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('POOL_NAME_TAKEN', `A map pool named "${input.name}" already exists`);
      throw error;
    }
  }

  async updatePool(id: string, input: Partial<CreateMapPoolInput>, actor: AuditActor, ip?: string | null) {
    const before = await this.poolOrThrow(id);
    const mode = input.mode === undefined ? before.mode : input.mode;
    const mapIds = input.mapIds ?? before.maps.map((m) => m.mapId);
    if (input.mapIds || input.mode !== undefined) await this.assertPoolMaps(mapIds, mode);
    try {
      await this.prisma.$transaction(async (tx) => {
        if (input.isDefault && mode) await tx.mapPool.updateMany({ where: { mode, isDefault: true, id: { not: id } }, data: { isDefault: false } });
        await tx.mapPool.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.mode !== undefined ? { mode: input.mode } : {}),
            ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          },
        });
        if (input.mapIds) {
          await tx.mapPoolMap.deleteMany({ where: { mapPoolId: id } });
          await tx.mapPoolMap.createMany({ data: input.mapIds.map((mapId, position) => ({ mapPoolId: id, mapId, position })) });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('POOL_NAME_TAKEN', 'A map pool with this name already exists');
      throw error;
    }
    const after = await this.poolOrThrow(id);
    await this.audit.record({
      actor,
      action: 'map_pool.update',
      targetType: 'map_pool',
      targetId: id,
      targetLabel: after.name,
      oldValue: { name: before.name, mode: before.mode, isDefault: before.isDefault, mapIds: before.maps.map((m) => m.mapId) },
      newValue: { name: after.name, mode: after.mode, isDefault: after.isDefault, mapIds: after.maps.map((m) => m.mapId) },
      ip,
    });
    await this.invalidate();
    return after;
  }

  async deletePool(id: string, actor: AuditActor, ip?: string | null): Promise<void> {
    const pool = await this.poolOrThrow(id);
    const used = (await this.prisma.tournament.count({ where: { mapPoolId: id } })) + (await this.prisma.match.count({ where: { mapPoolId: id } }));
    if (used > 0) throw conflict('POOL_IN_USE', 'This map pool is used by tournaments or matches');
    await this.prisma.mapPool.delete({ where: { id } });
    await this.audit.record({ actor, action: 'map_pool.delete', targetType: 'map_pool', targetId: id, targetLabel: pool.name, ip });
    await this.invalidate();
  }

  // ───────────── veto templates ─────────────

  async createVetoTemplate(input: CreateVetoTemplateInput, actor: AuditActor, ip?: string | null) {
    this.assertTemplateShape(input.steps, input.bestOf);
    const template = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.vetoTemplate.updateMany({ where: { bestOf: input.bestOf, isDefault: true }, data: { isDefault: false } });
      return tx.vetoTemplate.create({ data: { name: input.name, bestOf: input.bestOf, steps: input.steps as never, isDefault: input.isDefault } });
    });
    await this.audit.record({ actor, action: 'veto_template.create', targetType: 'veto_template', targetId: template.id, targetLabel: template.name, newValue: input, ip });
    return template;
  }

  async updateVetoTemplate(id: string, input: Partial<CreateVetoTemplateInput>, actor: AuditActor, ip?: string | null) {
    const before = await this.prisma.vetoTemplate.findUnique({ where: { id } });
    if (!before) throw notFound('VETO_TEMPLATE_NOT_FOUND', 'Veto template does not exist');
    const bestOf = (input.bestOf ?? before.bestOf) as BestOf;
    const steps = (input.steps ?? before.steps) as CreateVetoTemplateInput['steps'];
    this.assertTemplateShape(steps, bestOf);
    const template = await this.prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.vetoTemplate.updateMany({ where: { bestOf, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      return tx.vetoTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          bestOf,
          steps: steps as never,
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
    });
    await this.audit.record({ actor, action: 'veto_template.update', targetType: 'veto_template', targetId: id, targetLabel: template.name, oldValue: before, newValue: template, ip });
    return template;
  }

  async deleteVetoTemplate(id: string, actor: AuditActor, ip?: string | null): Promise<void> {
    const before = await this.prisma.vetoTemplate.findUnique({ where: { id } });
    if (!before) throw notFound('VETO_TEMPLATE_NOT_FOUND', 'Veto template does not exist');
    const used = await this.prisma.tournament.count({ where: { vetoTemplateId: id } });
    if (used > 0) throw conflict('TEMPLATE_IN_USE', 'This template is used by tournaments');
    await this.prisma.vetoTemplate.delete({ where: { id } });
    await this.audit.record({ actor, action: 'veto_template.delete', targetType: 'veto_template', targetId: id, targetLabel: before.name, oldValue: before, ip });
  }

  // ───────────── helpers ─────────────

  private assertTemplateShape(steps: CreateVetoTemplateInput['steps'], bestOf: BestOf): void {
    const errors = validateVetoShape(steps, bestOf);
    if (errors.length > 0) throw badRequest('INVALID_VETO_TEMPLATE', 'The veto order is not valid', errors);
  }

  private async assertPoolMaps(mapIds: string[], mode: GameMode | null): Promise<void> {
    if (new Set(mapIds).size !== mapIds.length) throw badRequest('DUPLICATE_MAPS', 'A map can only appear once in a pool');
    const maps = await this.prisma.gameMap.findMany({ where: { id: { in: mapIds } } });
    if (maps.length !== mapIds.length) throw badRequest('UNKNOWN_MAP', 'One or more maps do not exist');
    if (mode) {
      const unsupported = maps.filter((m) => !m.modes.includes(mode));
      if (unsupported.length > 0) {
        throw badRequest('MAP_MODE_MISMATCH', `These maps do not support ${mode}: ${unsupported.map((m) => m.name).join(', ')}`);
      }
    }
  }

  private async invalidate(): Promise<void> {
    await this.redis.deleteByPrefix(CACHE_PREFIX).catch(() => undefined);
  }
}
