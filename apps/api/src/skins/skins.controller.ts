import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createLoadoutSchema,
  grantSkinPermissionSchema,
  importLoadoutCodeSchema,
  importLoadoutJsonSchema,
  inventoryItemInputSchema,
  paintSeedSchema,
  floatSchema,
  setLoadoutItemsSchema,
  skinCommandSchema,
  skinSearchQuerySchema,
  steamId64Schema,
  stickerSearchQuerySchema,
  updateLoadoutSchema,
  maxGrantableSkinLevel,
  type GrantSkinPermissionInput,
  type InventoryItemInput,
} from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { RateLimit } from '../common/rate-limit.js';
import { PrismaService } from '../database/prisma.service.js';
import { Authenticated, CurrentAuth, OptionalAuth, Public, RequirePermission, ServerOnly, type AuthContext } from '../security/access.js';
import { InventoryService } from './inventory.service.js';
import { LoadoutsService } from './loadouts.service.js';
import { SkinPermissionsService, type GrantActor } from './skin-permissions.service.js';
import { SkinSyncService } from './skin-sync.service.js';
import { SkinsService } from './skins.service.js';

const idParam = z.uuid();

@Controller()
export class SkinsController {
  constructor(
    private readonly skins: SkinsService,
    private readonly permissions: SkinPermissionsService,
  ) {}

  @Get('skins')
  @Public()
  search(@Query({ schema: skinSearchQuerySchema }) query: z.infer<typeof skinSearchQuerySchema>) {
    return this.skins.search(query);
  }

  @Get('skins/:id')
  @Public()
  detail(@Param('id', { schema: idParam }) id: string) {
    return this.skins.detail(id);
  }

  @Get('stickers')
  @Public()
  stickers(@Query({ schema: stickerSearchQuerySchema }) query: z.infer<typeof stickerSearchQuerySchema>) {
    return this.skins.searchStickers(query);
  }

  /** What the signed-in player may do with skins right now (level, features, expiry). */
  @Get('skin-access')
  @Authenticated()
  async access(@CurrentAuth() auth: AuthContext) {
    const p = await this.permissions.effectiveFor(auth.userId);
    return { level: p.level, stickerCrafts: p.stickerCrafts, floatEditing: p.floatEditing, customLoadouts: p.customLoadouts, expiresAt: p.expiresAt, source: p.source };
  }
}

@Controller('inventory')
@Authenticated()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext) {
    return this.inventory.list(auth.userId);
  }

  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body({ schema: inventoryItemInputSchema }) body: InventoryItemInput) {
    return this.inventory.create(auth.userId, body);
  }

  @Put(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: inventoryItemInputSchema }) body: InventoryItemInput) {
    return this.inventory.update(auth.userId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.inventory.remove(auth.userId, id);
  }
}

@Controller('loadouts')
export class LoadoutsController {
  constructor(private readonly loadouts: LoadoutsService) {}

  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AuthContext) {
    return this.loadouts.list(auth.userId);
  }

  @Post()
  @Authenticated()
  create(@CurrentAuth() auth: AuthContext, @Body({ schema: createLoadoutSchema }) body: z.infer<typeof createLoadoutSchema>) {
    return this.loadouts.create(auth.userId, body.name);
  }

  /** Look at a shared loadout by its code; private loadouts only for their owner. */
  @Get('code/:code')
  @Public()
  @RateLimit({ limit: 60, windowSeconds: 60, name: 'loadout-code' })
  byCode(@Param('code', { schema: z.string().min(6).max(24) }) code: string, @OptionalAuth() auth?: AuthContext) {
    return this.loadouts.byCode(code, auth?.userId);
  }

  @Post('import')
  @Authenticated()
  @RateLimit({ limit: 30, windowSeconds: 60, name: 'loadout-import' })
  importCode(@CurrentAuth() auth: AuthContext, @Body({ schema: importLoadoutCodeSchema }) body: z.infer<typeof importLoadoutCodeSchema>) {
    return this.loadouts.importByCode(auth.userId, body.code, body.name);
  }

  @Post('import-json')
  @Authenticated()
  importJson(@CurrentAuth() auth: AuthContext, @Body({ schema: importLoadoutJsonSchema }) body: z.infer<typeof importLoadoutJsonSchema>) {
    return this.loadouts.importJson(auth.userId, body.data);
  }

  @Patch(':id')
  @Authenticated()
  update(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateLoadoutSchema }) body: z.infer<typeof updateLoadoutSchema>) {
    return this.loadouts.update(auth.userId, id, body);
  }

  @Delete(':id')
  @Authenticated()
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.loadouts.remove(auth.userId, id);
  }

  @Put(':id/items')
  @Authenticated()
  setItems(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: setLoadoutItemsSchema }) body: z.infer<typeof setLoadoutItemsSchema>) {
    return this.loadouts.setItems(auth.userId, id, body.items);
  }

  @Post(':id/duplicate')
  @Authenticated()
  duplicate(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string) {
    return this.loadouts.duplicate(auth.userId, id);
  }

  @Post(':id/activate')
  @Authenticated()
  activate(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string) {
    return this.loadouts.activate(auth.userId, id);
  }

  @Post(':id/share-code')
  @Authenticated()
  regenerate(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string) {
    return this.loadouts.regenerateCode(auth.userId, id);
  }

  @Get(':id/export')
  @Authenticated()
  export(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string) {
    return this.loadouts.export(auth.userId, id);
  }
}

const adminItemPatch = z.object({ pattern: paintSeedSchema.optional(), float: floatSchema.optional() }).refine((v) => v.pattern !== undefined || v.float !== undefined, { message: 'pattern or float is required' });

@Controller('admin/skins')
@RequirePermission('admin.access')
export class AdminSkinsController {
  constructor(
    private readonly permissions: SkinPermissionsService,
    private readonly sync: SkinSyncService,
    private readonly inventory: InventoryService,
    private readonly prisma: PrismaService,
  ) {}

  private actor(auth: AuthContext, req: Request): GrantActor {
    return { audit: actorFromAuth(auth), userId: auth.userId, permissions: auth.permissions, ip: req.ip, via: 'web' };
  }

  /** What the admin may hand out (drives the UI: which levels are selectable). */
  @Get('permissions')
  @RequirePermission('skin.assign')
  async list(@CurrentAuth() auth: AuthContext) {
    return { maxGrantableLevel: maxGrantableSkinLevel(auth.permissions), grants: await this.permissions.listActive() };
  }

  @Post('permissions')
  @RequirePermission('skin.assign')
  grant(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: grantSkinPermissionSchema }) body: GrantSkinPermissionInput) {
    return this.permissions.grant(body, this.actor(auth, req));
  }

  @Delete('permissions/:userId')
  @RequirePermission('skin.assign')
  @HttpCode(204)
  async revoke(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('userId', { schema: idParam }) userId: string, @Query('reason') reason?: string): Promise<void> {
    await this.permissions.revoke(userId, reason, this.actor(auth, req));
  }

  @Get('players/:userId')
  @RequirePermission('skin.assign')
  async player(@Param('userId', { schema: idParam }) userId: string) {
    const [effective, items] = await Promise.all([
      this.permissions.effectiveFor(userId),
      this.prisma.inventoryItem.findMany({ where: { ownerId: userId }, include: { skin: { select: { name: true, weaponName: true } } }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { effective, items: items.map((i) => ({ id: i.id, weapon: i.skin?.weaponName ?? i.weaponDefIndex, skin: i.skin?.name ?? null, float: i.floatValue, pattern: i.paintSeed })) };
  }

  @Patch('inventory/:id')
  @RequirePermission('skin.assign')
  editItem(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminItemPatch }) body: z.infer<typeof adminItemPatch>) {
    return this.inventory.adminEdit(id, { paintSeed: body.pattern, floatValue: body.float }, actorFromAuth(auth), req.ip);
  }

  @Post('sync-catalog')
  @RequirePermission('skin.catalog')
  syncCatalog() {
    return this.sync.syncCatalog();
  }

  @Post('sync-prices')
  @RequirePermission('skin.prices')
  syncPrices() {
    return this.sync.syncPrices();
  }
}

/** Endpoints the CS2 plugin calls (signed requests): load a player's skins and run the `!skch` command. */
@Controller('server/v1')
@ServerOnly()
@RateLimit({ limit: 600, windowSeconds: 60, name: 'gateway' })
export class SkinsGatewayController {
  constructor(
    private readonly loadouts: LoadoutsService,
    private readonly permissions: SkinPermissionsService,
    private readonly prisma: PrismaService,
  ) {}

  /** The loadout to apply for a player, already filtered by their current permission. Returns nothing unless skins are enabled. */
  @Get('loadouts/:steamId')
  async loadout(@Req() req: Request, @Param('steamId', { schema: steamId64Schema }) steamId: string) {
    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: req.gatewayServerId! }, select: { skinsEnabled: true } });
    if (!server.skinsEnabled) return { enabled: false, level: 0, items: [], skipped: [] };
    return { enabled: true, ...(await this.loadouts.resolveForServer(steamId)) };
  }

  /**
   * `!skch LEVEL PLAYER|all` from the game chat. The plugin only forwards; this endpoint decides: the actor's SteamID is
   * resolved to a platform user and must hold skin.assign plus a matching skin.level.N permission.
   */
  @Post('skin-permissions')
  @HttpCode(200)
  async skch(@Req() req: Request, @Body({ schema: skinCommandSchema }) body: z.infer<typeof skinCommandSchema>) {
    const actor = await this.prisma.user.findUnique({ where: { steamId: body.actorSteamId } });
    if (!actor) return { ok: false, error: 'UNKNOWN_ACTOR' };
    const permissions = await this.resolvePermissions(actor.id);
    const grantActor: GrantActor = { audit: { id: actor.id, label: actor.displayName }, userId: actor.id, permissions, via: 'ingame' };

    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: req.gatewayServerId! }, select: { currentMatchId: true, name: true } });
    let targets: string[];
    if (body.target === 'all') {
      if (!server.currentMatchId) return { ok: false, error: 'NO_MATCH' };
      const players = await this.prisma.matchPlayer.findMany({ where: { matchId: server.currentMatchId, removedAt: null, matchTeamId: { not: null } }, select: { userId: true } });
      targets = players.map((p) => p.userId);
    } else {
      const user = await this.prisma.user.findUnique({ where: { steamId: body.target }, select: { id: true } });
      if (!user) return { ok: false, error: 'UNKNOWN_TARGET' };
      targets = [user.id];
    }
    try {
      const count = await this.permissions.grantToMany(targets, body.level, body.durationMinutes, grantActor);
      return { ok: true, players: count, level: body.level };
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'FAILED';
      return { ok: false, error: code, message: (error as Error).message };
    }
  }

  private async resolvePermissions(userId: string) {
    const rows = await this.prisma.rolePermission.findMany({ where: { role: { users: { some: { userId } } } }, select: { permission: true } });
    const { effectivePermissions } = await import('@celtist/shared');
    return effectivePermissions(rows.map((r) => r.permission));
  }
}
