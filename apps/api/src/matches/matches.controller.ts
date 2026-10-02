import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  addPlayerSchema,
  adminAssignServerSchema,
  adminBanFromMatchSchema,
  adminChangeMapSchema,
  adminDecideSchema,
  adminEditScoreSchema,
  adminPardonSchema,
  adminReasonSchema,
  assignTeamSchema,
  controlReasonSchema,
  forceMapSchema,
  matchListQuerySchema,
  removeMatchPlayerSchema,
  updateMatchConfigSchema,
  vetoActionSchema,
  type MatchListQuery,
  type VetoActionInput,
} from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { Authenticated, CurrentAuth, OptionalAuth, Public, RequirePermission, type AuthContext } from '../security/access.js';
import { MatchAccessService, MatchControlService, type ControlCtx } from './match-control.service.js';
import { MatchVetoService } from './match-veto.service.js';
import { MatchesService } from './matches.service.js';

const idParam = z.uuid();

const viewerOf = (auth?: AuthContext) =>
  auth ? { userId: auth.userId, canSeeServer: auth.permissions.has('server.view'), isAdmin: auth.permissions.has('match.control') } : undefined;

@Controller('matches')
export class MatchesController {
  constructor(
    private readonly matches: MatchesService,
    private readonly veto: MatchVetoService,
    private readonly access: MatchAccessService,
  ) {}

  @Get()
  @Public()
  list(@Query({ schema: matchListQuerySchema }) query: MatchListQuery) {
    return this.matches.list(query);
  }

  @Get(':id')
  @Public()
  get(@Param('id', { schema: idParam }) id: string, @OptionalAuth() auth: AuthContext | undefined) {
    return this.matches.get(id, viewerOf(auth));
  }

  @Get(':id/scoreboard')
  @Public()
  scoreboard(@Param('id', { schema: idParam }) id: string) {
    return this.matches.scoreboard(id);
  }

  @Get(':id/veto')
  @Public()
  vetoState(@Param('id', { schema: idParam }) id: string) {
    return this.veto.view(id);
  }

  /** Veto step: the match controller may decide for either team; otherwise the captain of the team on turn. */
  @Post(':id/veto')
  @Authenticated()
  async vetoAction(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: vetoActionSchema }) body: VetoActionInput) {
    const asController = await this.access.resolve(id, auth).then(() => true, () => false);
    await this.veto.act(id, auth.userId, body, asController);
    return this.veto.view(id);
  }
}

/**
 * MATCH CONTROL – the panel used by the party leader and by admins. Both have exactly the same rights; the role only
 * shows up in the audit log. Every action is re-checked on the server (rights, match state, map pool, server).
 */
@Controller('matches/:id/control')
export class MatchControlController {
  constructor(
    private readonly control: MatchControlService,
    private readonly access: MatchAccessService,
  ) {}

  private async ctx(auth: AuthContext, matchId: string, req: Request): Promise<ControlCtx> {
    const role = await this.access.resolve(matchId, auth);
    return { actor: actorFromAuth(auth), actorUserId: auth.userId, role, ip: req.ip };
  }

  @Post('force-map')
  @Authenticated()
  @HttpCode(204)
  async forceMap(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: forceMapSchema }) body: z.infer<typeof forceMapSchema>): Promise<void> {
    await this.control.forceMap(id, body.mapNumber, body.mapId, body.reason, await this.ctx(auth, id, req));
  }

  @Post('start-veto')
  @Authenticated()
  @HttpCode(204)
  async startVeto(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.control.startVeto(id, await this.ctx(auth, id, req));
  }

  @Post('skip-veto')
  @Authenticated()
  @HttpCode(204)
  async skipVeto(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.control.skipVeto(id, await this.ctx(auth, id, req));
  }

  @Post('start')
  @Authenticated()
  @HttpCode(204)
  async start(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.control.start(id, await this.ctx(auth, id, req));
  }

  @Post('pause')
  @Authenticated()
  @HttpCode(204)
  async pause(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: controlReasonSchema }) body: z.infer<typeof controlReasonSchema>): Promise<void> {
    await this.control.pause(id, body.reason, await this.ctx(auth, id, req));
  }

  @Post('unpause')
  @Authenticated()
  @HttpCode(204)
  async unpause(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: controlReasonSchema }) body: z.infer<typeof controlReasonSchema>): Promise<void> {
    await this.control.unpause(id, body.reason, await this.ctx(auth, id, req));
  }

  @Post('resume')
  @Authenticated()
  @HttpCode(204)
  async resume(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: controlReasonSchema }) body: z.infer<typeof controlReasonSchema>): Promise<void> {
    await this.control.resume(id, body.reason, await this.ctx(auth, id, req));
  }

  @Post('restart')
  @Authenticated()
  @HttpCode(204)
  async restart(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: controlReasonSchema }) body: z.infer<typeof controlReasonSchema>): Promise<void> {
    await this.control.restart(id, body.reason, await this.ctx(auth, id, req));
  }

  @Post('end')
  @Authenticated()
  @HttpCode(204)
  async end(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: controlReasonSchema }) body: z.infer<typeof controlReasonSchema>): Promise<void> {
    await this.control.end(id, body.reason, await this.ctx(auth, id, req));
  }

  @Post('assign-server')
  @Authenticated()
  @HttpCode(204)
  async assignServer(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminAssignServerSchema.partial({ reason: true }) }) body: { serverId: string; reason?: string }): Promise<void> {
    await this.control.assignServer(id, body.serverId, body.reason, await this.ctx(auth, id, req));
  }

  @Post('assign-team')
  @Authenticated()
  @HttpCode(204)
  async assignTeam(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: assignTeamSchema }) body: z.infer<typeof assignTeamSchema>): Promise<void> {
    await this.control.assignTeam(id, body.userId, body.team, body.reason, await this.ctx(auth, id, req));
  }

  @Post('add-player')
  @Authenticated()
  @HttpCode(204)
  async addPlayer(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: addPlayerSchema }) body: z.infer<typeof addPlayerSchema>): Promise<void> {
    await this.control.addPlayer(id, body, body.reason, await this.ctx(auth, id, req));
  }

  @Post('remove-player')
  @Authenticated()
  @HttpCode(204)
  async removePlayer(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: removeMatchPlayerSchema }) body: z.infer<typeof removeMatchPlayerSchema>): Promise<void> {
    await this.control.removePlayer(id, body.userId, body.reason, await this.ctx(auth, id, req));
  }

  @Post('config')
  @Authenticated()
  @HttpCode(204)
  async config(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateMatchConfigSchema }) body: z.infer<typeof updateMatchConfigSchema>): Promise<void> {
    await this.control.updateConfig(id, body, await this.ctx(auth, id, req));
  }

  @Post('change-map')
  @Authenticated()
  @HttpCode(204)
  async changeMap(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminChangeMapSchema.partial({ reason: true }) }) body: { mapNumber: number; mapId: string; reason?: string }): Promise<void> {
    await this.control.changeRunningMap(id, body.mapNumber, body.mapId, body.reason, await this.ctx(auth, id, req));
  }
}

/** Admin-only operations that are not part of normal match control (granular permissions, mandatory reasons). */
@Controller('admin/matches')
@RequirePermission('admin.access')
export class AdminMatchesController {
  constructor(private readonly control: MatchControlService) {}

  private ctx(auth: AuthContext, req: Request): ControlCtx {
    return { actor: actorFromAuth(auth), actorUserId: auth.userId, role: 'ADMIN', ip: req.ip };
  }

  @Post(':id/ban-player')
  @RequirePermission('player.ban')
  @HttpCode(204)
  async ban(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminBanFromMatchSchema }) body: z.infer<typeof adminBanFromMatchSchema>): Promise<void> {
    await this.control.banFromMatch(id, body.userId, body.reason, this.ctx(auth, req));
  }

  @Post(':id/pardon-player')
  @RequirePermission('player.pardon')
  @HttpCode(204)
  async pardon(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminPardonSchema }) body: z.infer<typeof adminPardonSchema>): Promise<void> {
    await this.control.pardon(id, body.userId, body.reason, this.ctx(auth, req));
  }

  @Post(':id/edit-score')
  @RequirePermission('match.editscore')
  @HttpCode(204)
  async editScore(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminEditScoreSchema }) body: z.infer<typeof adminEditScoreSchema>): Promise<void> {
    await this.control.editScore(id, body, this.ctx(auth, req));
  }

  @Post(':id/decide')
  @RequirePermission('match.editscore')
  @HttpCode(204)
  async decide(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminDecideSchema }) body: z.infer<typeof adminDecideSchema>): Promise<void> {
    await this.control.decide(id, body.winner, body.reason, this.ctx(auth, req));
  }

  @Post(':id/cancel')
  @RequirePermission('match.cancel')
  @HttpCode(204)
  async cancel(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminReasonSchema }) body: { reason: string }): Promise<void> {
    await this.control.end(id, body.reason, this.ctx(auth, req));
  }
}
