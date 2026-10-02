import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  adminAddTeamSchema,
  adminEditTeamSchema,
  adminReasonSchema,
  assignPlayersSchema,
  autoAssignSchema,
  createTournamentSchema,
  matchListQuerySchema,
  registerSchema,
  tournamentListQuerySchema,
  updateTournamentSchema,
  type CreateTournamentInput,
  type UpdateTournamentInput,
} from '@celtist/shared';
import { actorFromAuth } from '../audit/audit.service.js';
import { Authenticated, CurrentAuth, OptionalAuth, Public, RequirePermission, type AuthContext } from '../security/access.js';
import { MatchesService } from '../matches/matches.service.js';
import { TournamentTeamsService } from './tournament-teams.service.js';
import { TournamentsService, type Actor } from './tournaments.service.js';

const idParam = z.uuid();

const actorOf = (auth: AuthContext, req: Request): Actor => ({ audit: actorFromAuth(auth), userId: auth.userId, ip: req.ip });
const canSeePrivate = (auth?: AuthContext): boolean => !!auth && (auth.permissions.has('tournament.create') || auth.permissions.has('tournament.edit') || auth.permissions.has('tournament.manage'));

@Controller('tournaments')
export class TournamentsController {
  constructor(
    private readonly tournaments: TournamentsService,
    private readonly teams: TournamentTeamsService,
    private readonly matches: MatchesService,
  ) {}

  @Get()
  @Public()
  list(@Query({ schema: tournamentListQuerySchema }) query: z.infer<typeof tournamentListQuerySchema>, @OptionalAuth() auth?: AuthContext) {
    return this.tournaments.list(query, canSeePrivate(auth));
  }

  @Get(':id')
  @Public()
  get(@Param('id', { schema: idParam }) id: string, @OptionalAuth() auth?: AuthContext) {
    return this.tournaments.get(id, auth?.userId, canSeePrivate(auth));
  }

  @Get(':id/bracket')
  @Public()
  bracket(@Param('id', { schema: idParam }) id: string) {
    return this.tournaments.bracket(id);
  }

  @Get(':id/matches')
  @Public()
  matchesOf(@Param('id', { schema: idParam }) id: string, @Query({ schema: matchListQuerySchema }) query: z.infer<typeof matchListQuerySchema>) {
    return this.matches.list({ ...query, tournamentId: id });
  }

  @Post(':id/register')
  @Authenticated()
  register(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: registerSchema }) body: z.infer<typeof registerSchema>) {
    return this.teams.register(id, auth.userId, body);
  }

  @Delete(':id/register')
  @Authenticated()
  @HttpCode(204)
  async withdraw(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.teams.withdraw(id, auth.userId);
  }
}

@Controller('admin/tournaments')
@RequirePermission('admin.access')
export class AdminTournamentsController {
  constructor(
    private readonly tournaments: TournamentsService,
    private readonly teams: TournamentTeamsService,
  ) {}

  @Post()
  @RequirePermission('tournament.create')
  create(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Body({ schema: createTournamentSchema }) body: CreateTournamentInput) {
    return this.tournaments.create(body, actorOf(auth, req));
  }

  @Patch(':id')
  @RequirePermission('tournament.edit')
  update(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateTournamentSchema }) body: UpdateTournamentInput) {
    return this.tournaments.update(id, body, actorOf(auth, req));
  }

  @Delete(':id')
  @RequirePermission('tournament.delete')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.tournaments.delete(id, actorOf(auth, req));
  }

  @Post(':id/publish')
  @RequirePermission('tournament.edit')
  @HttpCode(204)
  async publish(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.tournaments.publish(id, actorOf(auth, req));
  }

  @Post(':id/start')
  @RequirePermission('tournament.start')
  start(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string) {
    return this.tournaments.start(id, actorOf(auth, req));
  }

  @Post(':id/pause')
  @RequirePermission('tournament.manage')
  @HttpCode(204)
  async pause(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.tournaments.pause(id, actorOf(auth, req));
  }

  @Post(':id/resume')
  @RequirePermission('tournament.manage')
  @HttpCode(204)
  async resume(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.tournaments.resume(id, actorOf(auth, req));
  }

  @Post(':id/cancel')
  @RequirePermission('tournament.manage')
  @HttpCode(204)
  async cancel(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminReasonSchema }) body: { reason: string }): Promise<void> {
    await this.tournaments.cancel(id, body.reason, actorOf(auth, req));
  }

  @Get(':id/registrations')
  @RequirePermission('tournament.teams')
  async registrations(@Param('id', { schema: idParam }) id: string) {
    return { registrations: await this.teams.listRegistrations(id) };
  }

  @Post(':id/teams')
  @RequirePermission('tournament.teams')
  addTeam(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: adminAddTeamSchema }) body: z.infer<typeof adminAddTeamSchema>) {
    return this.teams.adminAddTeam(id, body, actorOf(auth, req));
  }

  @Patch(':id/teams/:teamId')
  @RequirePermission('tournament.teams')
  @HttpCode(204)
  async editTeam(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Param('teamId', { schema: idParam }) teamId: string, @Body({ schema: adminEditTeamSchema }) body: z.infer<typeof adminEditTeamSchema>): Promise<void> {
    await this.teams.adminEditTeam(id, teamId, body, actorOf(auth, req));
  }

  @Delete(':id/teams/:teamId')
  @RequirePermission('tournament.teams')
  @HttpCode(204)
  async removeTeam(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Param('teamId', { schema: idParam }) teamId: string): Promise<void> {
    await this.teams.adminRemoveTeam(id, teamId, actorOf(auth, req));
  }

  @Post(':id/assign-players')
  @RequirePermission('tournament.teams')
  assign(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: assignPlayersSchema }) body: z.infer<typeof assignPlayersSchema>) {
    return this.teams.assignPlayers(id, body.teams, actorOf(auth, req));
  }

  @Post(':id/auto-assign')
  @RequirePermission('tournament.teams')
  autoAssign(@CurrentAuth() auth: AuthContext, @Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: autoAssignSchema }) body: z.infer<typeof autoAssignSchema>) {
    return this.teams.autoAssign(id, body.strategy, actorOf(auth, req));
  }
}
