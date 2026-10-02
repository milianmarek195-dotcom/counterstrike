import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  commandAckSchema,
  commandsQuerySchema,
  eventBatchSchema,
  heartbeatSchema,
  mapResultSchema,
  playerAuthorizeSchema,
  type HeartbeatPayload,
  type MapResultPayload,
  type ServerEventPayload,
} from '@celtist/shared';
import { forbidden } from '../common/errors.js';
import { RateLimit } from '../common/rate-limit.js';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { ServerOnly } from '../security/access.js';
import { ServerHeartbeatService } from '../servers/server-heartbeat.service.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchConfigService } from './match-config.service.js';
import { MatchFinalizerService } from './match-finalizer.service.js';
import { ServerEventsService } from './server-events.service.js';

const idParam = z.uuid();

/**
 * API used by the CS2 plugin. Every request is signed (ServerAuthGuard); the caller's server id comes from the
 * verified signature, never from the body, so a server can only ever act on its own match.
 */
@Controller('server/v1')
@ServerOnly()
@RateLimit({ limit: 600, windowSeconds: 60, name: 'gateway' })
export class ServerGatewayController {
  constructor(
    private readonly heartbeat: ServerHeartbeatService,
    private readonly commands: MatchCommandService,
    private readonly events: ServerEventsService,
    private readonly finalizer: MatchFinalizerService,
    private readonly config: MatchConfigService,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  @Post('heartbeat')
  @HttpCode(200)
  beat(@Req() req: Request, @Body({ schema: heartbeatSchema }) body: HeartbeatPayload) {
    return this.heartbeat.handle(req.gatewayServerId!, body);
  }

  /** Long-poll: returns as soon as a command is pending, or an empty list after `wait` seconds. */
  @Get('commands')
  async fetchCommands(@Req() req: Request, @Query({ schema: commandsQuerySchema }) query: z.infer<typeof commandsQuerySchema>) {
    const rows = await this.commands.fetchForServer(req.gatewayServerId!, query.wait);
    return { commands: rows.map((r) => ({ id: r.id, type: r.type, matchId: r.matchId, payload: r.payload, createdAt: r.createdAt })) };
  }

  @Post('commands/:id/ack')
  @HttpCode(204)
  async ack(@Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: commandAckSchema }) body: z.infer<typeof commandAckSchema>): Promise<void> {
    await this.commands.acknowledge(req.gatewayServerId!, id, body.status, body.reason);
  }

  @Post('events')
  @HttpCode(200)
  async ingest(@Req() req: Request, @Body({ schema: eventBatchSchema }) body: { events: ServerEventPayload[] }) {
    return this.events.ingest(req.gatewayServerId!, body.events);
  }

  @Post('matches/:id/result')
  @HttpCode(200)
  result(@Req() req: Request, @Param('id', { schema: idParam }) id: string, @Body({ schema: mapResultSchema }) body: MapResultPayload) {
    if (body.matchId !== id) throw forbidden('The report belongs to another match', 'MATCH_MISMATCH');
    return this.finalizer.acceptMapResult(req.gatewayServerId!, body);
  }

  @Get('matches/:id/config')
  async matchConfig(@Req() req: Request, @Param('id', { schema: idParam }) id: string) {
    const match = await this.prisma.match.findUnique({ where: { id }, select: { serverId: true } });
    if (!match || match.serverId !== req.gatewayServerId) throw forbidden('This match is not hosted on your server', 'NOT_YOUR_MATCH');
    return this.config.build(id);
  }

  /** Join check: may this SteamID play on this server right now? */
  @Post('players/authorize')
  @HttpCode(200)
  async authorize(@Req() req: Request, @Body({ schema: playerAuthorizeSchema }) body: z.infer<typeof playerAuthorizeSchema>) {
    const server = await this.prisma.server.findUniqueOrThrow({ where: { id: req.gatewayServerId! }, select: { currentMatchId: true } });
    if (!server.currentMatchId) return { allowed: false, reason: 'NO_MATCH' };

    const player = await this.prisma.matchPlayer.findFirst({
      where: { matchId: server.currentMatchId, steamId: body.steamId },
      include: { matchTeam: { select: { slot: true } } },
    });
    if (!player) return { allowed: false, reason: 'NOT_IN_MATCH' };
    if (player.removedAt) return { allowed: false, reason: 'REMOVED_FROM_MATCH' };
    if (!player.matchTeam) return { allowed: false, reason: 'NOT_ASSIGNED' }; // in the lobby but not on a team yet: ACCESS DENIED

    const ban = await this.prisma.ban.findFirst({
      where: { userId: player.userId, type: 'PLATFORM', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }] },
    });
    if (ban) return { allowed: false, reason: 'BANNED' };
    return { allowed: true, matchId: server.currentMatchId, team: player.matchTeam.slot, isSubstitute: player.isSubstitute };
  }
}
