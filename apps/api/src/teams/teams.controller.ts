import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { createTeamSchema, inviteToTeamSchema, teamListQuerySchema, updateTeamSchema } from '@celtist/shared';
import { badRequest } from '../common/errors.js';
import { Authenticated, CurrentAuth, OptionalAuth, Public, type AuthContext } from '../security/access.js';
import { TeamsService } from './teams.service.js';

const idParam = z.uuid();
const userBody = z.object({ userId: z.uuid() });

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @Public()
  list(@Query({ schema: teamListQuerySchema }) query: z.infer<typeof teamListQuerySchema>) {
    return this.teams.list(query);
  }

  @Get('me')
  @Authenticated()
  mine(@CurrentAuth() auth: AuthContext) {
    return this.teams.mine(auth.userId);
  }

  @Post()
  @Authenticated()
  create(@CurrentAuth() auth: AuthContext, @Body({ schema: createTeamSchema }) body: z.infer<typeof createTeamSchema>) {
    return this.teams.create(auth.userId, body);
  }

  @Post('invites/:id/accept')
  @Authenticated()
  @HttpCode(204)
  async accept(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.teams.respond(id, auth.userId, true);
  }

  @Post('invites/:id/decline')
  @Authenticated()
  @HttpCode(204)
  async decline(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.teams.respond(id, auth.userId, false);
  }

  @Get(':id')
  @Public()
  get(@OptionalAuth() auth: AuthContext | undefined, @Param('id', { schema: idParam }) id: string) {
    return this.teams.get(id, auth?.userId);
  }

  @Get(':id/logo')
  @Public()
  @Header('Cache-Control', 'public, max-age=3600')
  @Header('X-Content-Type-Options', 'nosniff')
  async logo(@Param('id', { schema: idParam }) id: string, @Res() res: Response): Promise<void> {
    const { data, mime } = await this.teams.logo(id);
    res.type(mime).send(data);
  }

  @Put(':id/logo')
  @Authenticated()
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 512 * 1024, files: 1 } }))
  async setLogo(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @UploadedFile() file: { buffer: Buffer } | undefined): Promise<void> {
    if (!file) throw badRequest('INVALID_LOGO', 'Send the image as multipart field "file"');
    await this.teams.setLogo(id, auth.userId, file.buffer);
  }

  @Patch(':id')
  @Authenticated()
  @HttpCode(204)
  async update(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: updateTeamSchema }) body: z.infer<typeof updateTeamSchema>): Promise<void> {
    await this.teams.update(id, auth.userId, body);
  }

  @Post(':id/invite')
  @Authenticated()
  @HttpCode(204)
  async invite(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: inviteToTeamSchema }) body: z.infer<typeof inviteToTeamSchema>): Promise<void> {
    await this.teams.invite(id, auth.userId, body);
  }

  @Post(':id/kick')
  @Authenticated()
  @HttpCode(204)
  async kick(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: userBody }) body: z.infer<typeof userBody>): Promise<void> {
    await this.teams.kick(id, auth.userId, body.userId);
  }

  @Post(':id/leave')
  @Authenticated()
  @HttpCode(204)
  async leave(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.teams.leave(id, auth.userId);
  }

  @Post(':id/captain')
  @Authenticated()
  @HttpCode(204)
  async captain(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string, @Body({ schema: userBody }) body: z.infer<typeof userBody>): Promise<void> {
    await this.teams.transferCaptain(id, auth.userId, body.userId);
  }

  @Delete(':id')
  @Authenticated()
  @HttpCode(204)
  async disband(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.teams.disband(id, auth.userId);
  }
}
