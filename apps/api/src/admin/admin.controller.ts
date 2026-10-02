import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  adminPlayerSearchSchema,
  auditQuerySchema,
  createBanSchema,
  createRoleSchema,
  rankTiersSchema,
  setEloSchema,
  setRankSchema,
  setSettingSchema,
  setUserRolesSchema,
  unbanSchema,
  updateRoleSchema,
  updateWebhookSchema,
  webhookSchema,
  SETTING_KEYS,
  type SettingKey,
} from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { RequirePermission, CurrentAuth, type AuthContext } from '../security/access.js';
import { SettingsService } from '../settings/settings.service.js';
import { AdminService, type AdminCtx } from './admin.service.js';
import { WebhooksService } from './webhooks.service.js';

const idParam = z.uuid();
const ctxOf = (auth: AuthContext, req: Request): AdminCtx => ({ actor: actorFromAuth(auth), actorUserId: auth.userId, ip: req.ip });
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), active: z.coerce.boolean().default(false) });

@Controller('admin')
@RequirePermission('admin.access')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly settings: SettingsService,
    private readonly webhooks: WebhooksService,
  ) {}

  @Get('dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  // players
  @Get('players')
  @RequirePermission('player.view')
  players(@Query({ schema: adminPlayerSearchSchema }) query: z.infer<typeof adminPlayerSearchSchema>) {
    return this.admin.searchPlayers(query);
  }

  @Get('players/:id')
  @RequirePermission('player.view')
  player(@Param('id', { schema: idParam }) id: string) {
    return this.admin.playerDetail(id);
  }

  @Post('players/:id/elo')
  @RequirePermission('player.elo.edit')
  elo(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: setEloSchema }) body: z.infer<typeof setEloSchema>) {
    return this.admin.setElo(id, body.mode, body.elo, body.reason, ctxOf(auth, req));
  }

  @Post('players/:id/rank')
  @RequirePermission('player.rank.edit')
  rank(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: setRankSchema }) body: z.infer<typeof setRankSchema>) {
    return this.admin.setRank(id, body.mode, body.tierKey, body.reason, ctxOf(auth, req));
  }

  @Post('players/:id/pardon')
  @RequirePermission('player.pardon')
  pardon(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: unbanSchema }) body: z.infer<typeof unbanSchema>) {
    return this.admin.pardon(id, body.reason, ctxOf(auth, req));
  }

  @Put('players/:id/roles')
  @RequirePermission('role.manage')
  @HttpCode(204)
  async setRoles(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: setUserRolesSchema }) body: z.infer<typeof setUserRolesSchema>): Promise<void> {
    await this.admin.setUserRoles(id, body.roleKeys, body.reason, ctxOf(auth, req));
  }

  // bans
  @Get('bans')
  @RequirePermission('player.view')
  bans(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    return this.admin.listBans(query.page, query.pageSize, query.active);
  }

  @Post('bans')
  @RequirePermission('player.ban')
  ban(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createBanSchema }) body: z.infer<typeof createBanSchema>) {
    return this.admin.ban(body, ctxOf(auth, req));
  }

  @Post('players/:id/unban')
  @RequirePermission('player.unban')
  @HttpCode(204)
  async unban(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: unbanSchema }) body: z.infer<typeof unbanSchema>): Promise<void> {
    await this.admin.unban(id, body.reason, ctxOf(auth, req));
  }

  // roles
  @Get('roles')
  @RequirePermission('role.manage')
  roles() {
    return this.admin.listRoles();
  }

  @Post('roles')
  @RequirePermission('role.manage')
  createRole(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createRoleSchema }) body: z.infer<typeof createRoleSchema>) {
    return this.admin.createRole(body, ctxOf(auth, req));
  }

  @Patch('roles/:id')
  @RequirePermission('role.manage')
  @HttpCode(204)
  async updateRole(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateRoleSchema }) body: z.infer<typeof updateRoleSchema>): Promise<void> {
    await this.admin.updateRole(id, body, ctxOf(auth, req));
  }

  @Delete('roles/:id')
  @RequirePermission('role.manage')
  @HttpCode(204)
  async deleteRole(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.admin.deleteRole(id, ctxOf(auth, req));
  }

  // audit
  @Get('audit')
  @RequirePermission('audit.view')
  audit(@Query({ schema: auditQuerySchema }) query: z.infer<typeof auditQuerySchema>) {
    return this.admin.auditLog(query);
  }

  // settings
  @Get('settings')
  @RequirePermission('settings.manage')
  async allSettings() {
    return { settings: await this.settings.all() };
  }

  @Put('settings/:key')
  @RequirePermission('settings.manage')
  async setSetting(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('key', { schema: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]) }) key: SettingKey, @Body({ schema: setSettingSchema }) body: z.infer<typeof setSettingSchema>) {
    const result = await this.settings.set(key, body.value, auth.userId);
    await this.admin['audit'].record({ actor: actorFromAuth(auth), action: 'settings.update', targetType: 'settings', targetId: key, oldValue: result.oldValue, newValue: result.newValue, ip: req.ip });
    return { key, value: result.newValue };
  }

  @Put('rank-tiers')
  @RequirePermission('settings.manage')
  rankTiers(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: rankTiersSchema }) body: z.infer<typeof rankTiersSchema>) {
    return this.admin.setRankTiers(body.tiers.map((t, i) => ({ ...t, position: i + 1 })), ctxOf(auth, req));
  }

  // webhooks
  @Get('webhooks')
  @RequirePermission('settings.manage')
  async listWebhooks() {
    return { webhooks: await this.webhooks.list() };
  }

  @Post('webhooks')
  @RequirePermission('settings.manage')
  createWebhook(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: webhookSchema }) body: z.infer<typeof webhookSchema>) {
    return this.webhooks.create(body, actorFromAuth(auth), auth.userId, req.ip);
  }

  @Patch('webhooks/:id')
  @RequirePermission('settings.manage')
  @HttpCode(204)
  async updateWebhook(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateWebhookSchema }) body: z.infer<typeof updateWebhookSchema>): Promise<void> {
    await this.webhooks.update(id, body, actorFromAuth(auth), req.ip);
  }

  @Delete('webhooks/:id')
  @RequirePermission('settings.manage')
  @HttpCode(204)
  async deleteWebhook(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.webhooks.remove(id, actorFromAuth(auth), req.ip);
  }

  @Post('webhooks/:id/test')
  @RequirePermission('settings.manage')
  testWebhook(@Param('id', { schema: idParam }) id: string) {
    return this.webhooks.test(id);
  }
}
