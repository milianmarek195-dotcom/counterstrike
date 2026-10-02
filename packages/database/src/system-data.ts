import {
  DEFAULT_MAPS,
  DEFAULT_MAP_POOLS,
  DEFAULT_RANK_TIERS,
  DEFAULT_ROLES,
  SETTING_KEYS,
  settingDefault,
} from '@celtist/shared';
import type { PrismaClient } from './generated/prisma/client.js';

export interface EnsureSystemDataResult {
  rolesCreated: string[];
  rankTiersCreated: number;
  mapsCreated: number;
  mapPoolsCreated: number;
  settingsCreated: string[];
}

/**
 * Data the platform cannot work without: system roles, rank tiers, default maps/pools and setting defaults.
 * Idempotent and non-destructive: existing rows (including admin edits) are never overwritten, and empty
 * tables are only filled once. This is NOT demo data (see seed/ for that).
 */
export async function ensureSystemData(prisma: PrismaClient): Promise<EnsureSystemDataResult> {
  const result: EnsureSystemDataResult = {
    rolesCreated: [],
    rankTiersCreated: 0,
    mapsCreated: 0,
    mapPoolsCreated: 0,
    settingsCreated: [],
  };

  for (const role of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: role.key } });
    if (existing) continue;
    await prisma.role.create({
      data: {
        key: role.key,
        name: role.name,
        description: role.description,
        position: role.position,
        isSystem: true,
        permissions: { create: [...new Set(role.permissions)].map((permission) => ({ permission })) },
      },
    });
    result.rolesCreated.push(role.key);
  }

  if ((await prisma.rankTier.count()) === 0) {
    await prisma.rankTier.createMany({
      data: DEFAULT_RANK_TIERS.map((t) => ({ key: t.key, name: t.name, minElo: t.minElo, color: t.color, position: t.position })),
    });
    result.rankTiersCreated = DEFAULT_RANK_TIERS.length;
  }

  if ((await prisma.gameMap.count()) === 0) {
    await prisma.gameMap.createMany({
      data: DEFAULT_MAPS.map((m, index) => ({ key: m.key, name: m.name, modes: m.modes, position: (index + 1) * 10 })),
    });
    result.mapsCreated = DEFAULT_MAPS.length;
  }

  if ((await prisma.mapPool.count()) === 0) {
    const maps = await prisma.gameMap.findMany({ select: { id: true, key: true } });
    const idByKey = new Map(maps.map((m) => [m.key, m.id] as const));
    for (const pool of DEFAULT_MAP_POOLS) {
      const mapIds = pool.mapKeys.map((key) => idByKey.get(key)).filter((id): id is string => id !== undefined);
      if (mapIds.length === 0) continue;
      await prisma.mapPool.create({
        data: {
          name: pool.name,
          mode: pool.mode,
          isDefault: true,
          maps: { create: mapIds.map((mapId, position) => ({ mapId, position })) },
        },
      });
      result.mapPoolsCreated++;
    }
  }

  const existingSettings = new Set((await prisma.platformSetting.findMany({ select: { key: true } })).map((s) => s.key));
  for (const key of SETTING_KEYS) {
    if (existingSettings.has(key)) continue;
    await prisma.platformSetting.create({ data: { key, value: settingDefault(key) as never } });
    result.settingsCreated.push(key);
  }

  return result;
}
