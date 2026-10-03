import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { createPartyMatchSchema, steamId64Schema, type CreatePartyMatchInput } from '@celtist/shared';
import { Authenticated, CurrentAuth, type AuthContext } from '../security/access.js';
import { PartiesService } from './parties.service.js';
import { SteamFriendsService } from './steam-friends.service.js';

const idParam = z.uuid();
const inviteBody = z.object({ userId: z.uuid().optional(), steamId: steamId64Schema.optional() }).refine((v) => v.userId || v.steamId, { message: 'userId or steamId is required' });
const userBody = z.object({ userId: z.uuid() });

/** The party is the starting point of the website-first match flow: party → players → teams → map → server → connect. */
@Controller('parties')
@Authenticated()
export class PartiesController {
  constructor(
    private readonly parties: PartiesService,
    private readonly friends: SteamFriendsService,
  ) {}

  /** Steam friends that are registered here – invitable with the existing invite endpoint (by steamId). */
  @Get('friends')
  steamFriends(@CurrentAuth() auth: AuthContext) {
    return this.friends.friendsOf(auth.userId);
  }

  @Get('me')
  mine(@CurrentAuth() auth: AuthContext) {
    return this.parties.mine(auth.userId);
  }

  @Post()
  async create(@CurrentAuth() auth: AuthContext) {
    await this.parties.create(auth.userId);
    return this.parties.mine(auth.userId);
  }

  @Post('invite')
  @HttpCode(204)
  async invite(@CurrentAuth() auth: AuthContext, @Body({ schema: inviteBody }) body: z.infer<typeof inviteBody>): Promise<void> {
    await this.parties.invite(auth.userId, body);
  }

  @Post('invites/:id/accept')
  @HttpCode(204)
  async accept(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.parties.acceptInvite(auth.userId, id);
  }

  @Post('invites/:id/decline')
  @HttpCode(204)
  async decline(@CurrentAuth() auth: AuthContext, @Param('id', { schema: idParam }) id: string): Promise<void> {
    await this.parties.declineInvite(auth.userId, id);
  }

  @Post('leave')
  @HttpCode(204)
  async leave(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.parties.leave(auth.userId);
  }

  @Post('kick')
  @HttpCode(204)
  async kick(@CurrentAuth() auth: AuthContext, @Body({ schema: userBody }) body: z.infer<typeof userBody>): Promise<void> {
    await this.parties.kick(auth.userId, body.userId);
  }

  @Post('transfer-leadership')
  @HttpCode(204)
  async transfer(@CurrentAuth() auth: AuthContext, @Body({ schema: userBody }) body: z.infer<typeof userBody>): Promise<void> {
    await this.parties.transferLeadership(auth.userId, body.userId);
  }

  @Delete()
  @HttpCode(204)
  async disband(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.parties.disband(auth.userId);
  }

  /** Opens a match for the party; the leader controls it (and so do admins). Team sizes are free per side. */
  @Post('match')
  createMatch(@CurrentAuth() auth: AuthContext, @Body({ schema: createPartyMatchSchema }) body: CreatePartyMatchInput) {
    return this.parties.createMatch(auth.userId, body);
  }
}
