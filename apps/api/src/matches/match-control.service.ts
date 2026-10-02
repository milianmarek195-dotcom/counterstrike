import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import type { Match, MatchStatus } from '@celtist/database';
import { MATCH_SETUP_STATUSES, type TeamSlot, type UpdateMatchConfigInput } from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { ServerAllocator } from '../servers/server-allocator.service.js';
import { effectiveStatus } from '../servers/servers.service.js';
import type { AuthContext } from '../security/access.js';
import { MatchFactory } from './core/match-factory.service.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchConfigService } from './match-config.service.js';
import { MatchFinalizerService } from './match-finalizer.service.js';
import { MatchLifecycleService } from './match-lifecycle.service.js';
import { MatchVetoService } from './match-veto.service.js';

export type ControlRole = 'ADMIN' | 'PARTY_LEADER';

export interface ControlCtx {
  actor: AuditActor;
  actorUserId: string | null;
  role: ControlRole;
  ip?: string | null;
}

const OPEN_STATUSES: MatchStatus[] = ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'LIVE', 'SERVER_ERROR'];

/**
 * Who may steer a match: administrators (permission `match.control`) and the match's party leader. Both get exactly the
 * same rights over the match – there is no reduced "leader" role. Decided here, on the server, for every action.
 */
@Injectable()
export class MatchAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(matchId: string, auth: AuthContext): Promise<ControlRole> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { controllerId: true } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (auth.permissions.has('match.control')) return 'ADMIN';
    if (match.controllerId && match.controllerId === auth.userId) return 'PARTY_LEADER';
    throw forbidden('Only the party leader or an admin can control this match', 'NOT_MATCH_CONTROLLER');
  }
}

/**
 * Everything a controller can do to a match. Each operation validates the match state, changes the data, tells the
 * game server where necessary (a command the plugin acknowledges and re-validates) and writes an audit entry with
 * actor, role, target, old and new value. Setup changes (teams, map, config) are only possible before the match starts,
 * so a running match can never be pushed into an inconsistent state.
 */
@Injectable()
export class MatchControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly commands: MatchCommandService,
    private readonly config: MatchConfigService,
    private readonly lifecycle: MatchLifecycleService,
    private readonly veto: MatchVetoService,
    private readonly finalizer: MatchFinalizerService,
    private readonly allocator: ServerAllocator,
    private readonly factory: MatchFactory,
    private readonly events: EventEmitter2,
  ) {}

  // ─────────────── map control ───────────────

  async forceMap(matchId: string, mapNumber: number, mapId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const { oldMap, newMap } = await this.lifecycle.forceMap(matchId, mapNumber, mapId);
    await this.log(ctx, 'match.force_map', matchId, reason, { map: oldMap, mapNumber }, { map: newMap, mapNumber, state: 'MAP_FORCED' });
  }

  async startVeto(matchId: string, ctx: ControlCtx): Promise<void> {
    if (!(await this.lifecycle.startVeto(matchId))) throw conflict('STATE_CHANGED', 'The match state changed, try again');
    await this.log(ctx, 'match.veto_start', matchId, undefined, undefined, { state: 'VETO' });
  }

  /** Skips the veto: the remaining steps are decided at random and the match moves on to configuration. */
  async skipVeto(matchId: string, ctx: ControlCtx): Promise<void> {
    await this.veto.skip(matchId);
    await this.log(ctx, 'match.veto_skip', matchId, undefined, { state: 'VETO' }, { state: 'CONFIGURING' });
  }

  // ─────────────── match flow ───────────────

  async start(matchId: string, ctx: ControlCtx): Promise<void> {
    await this.lifecycle.startMatch(matchId);
    await this.log(ctx, 'match.start', matchId, undefined, undefined, { state: 'CONFIGURING' });
  }

  async pause(matchId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['LIVE']);
    await this.command(match, 'MATCH_PAUSE', { reason }, ctx);
    await this.log(ctx, 'match.pause', matchId, reason);
  }

  async unpause(matchId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['LIVE']);
    await this.command(match, 'MATCH_UNPAUSE', { reason }, ctx);
    await this.log(ctx, 'match.resume', matchId, reason);
  }

  /** SERVER_ERROR → LIVE: the server is back and continues the match where it stopped. */
  async resume(matchId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['SERVER_ERROR']);
    await this.requireServerReachable(match.serverId);
    if (!(await this.lifecycle.cas(matchId, 'SERVER_ERROR', 'LIVE'))) throw conflict('STATE_CHANGED', 'The match state changed, try again');
    await this.command(match, 'MATCH_RESUME', { config: await this.config.build(matchId), reason }, ctx);
    await this.log(ctx, 'match.resume_after_error', matchId, reason, { state: 'SERVER_ERROR' }, { state: 'LIVE' });
    this.lifecycle.emitUpdated(matchId);
  }

  /** Starts the unfinished maps over on the current server. */
  async restart(matchId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['LIVE', 'SERVER_ERROR', 'CONFIGURING']);
    await this.requireServerReachable(match.serverId);
    await this.prisma.transact(async (tx) => {
      await tx.matchMap.updateMany({ where: { matchId, status: { in: ['PENDING', 'LIVE'] } }, data: { status: 'PENDING', scoreA: 0, scoreB: 0, startedAt: null } });
      await tx.match.update({ where: { id: matchId }, data: { status: 'CONFIGURING', pausedAt: null, pausedByTeam: null } });
    });
    await this.command(match, 'MATCH_RESTART', { config: await this.config.build(matchId), reason }, ctx);
    await this.log(ctx, 'match.restart', matchId, reason, { state: match.status }, { state: 'CONFIGURING' });
    this.lifecycle.emitUpdated(matchId);
  }

  /** END MATCH: cancels an open match and releases the server (no result, no Elo). */
  async end(matchId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { status: true } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (!(await this.lifecycle.cancel(matchId, `${ctx.role}: ${reason ?? 'ended by controller'}`))) throw conflict('MATCH_CLOSED', `The match is already ${match.status}`);
    await this.log(ctx, 'match.end', matchId, reason, { state: match.status }, { state: 'CANCELLED' });
  }

  /** Mid-match map change (restarts the map). Only for running matches; setup uses forceMap. */
  async changeRunningMap(matchId: string, mapNumber: number, mapId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['CONFIGURING', 'LIVE', 'SERVER_ERROR']);
    const [matchMap, map] = await Promise.all([
      this.prisma.matchMap.findUnique({ where: { matchId_mapNumber: { matchId, mapNumber } }, include: { map: true } }),
      this.prisma.gameMap.findUnique({ where: { id: mapId }, include: { pools: { select: { mapPoolId: true } } } }),
    ]);
    if (!matchMap) throw notFound('MAP_NOT_FOUND', `This match has no map ${mapNumber}`);
    if (matchMap.status === 'FINISHED') throw conflict('MAP_FINISHED', 'That map has already been played');
    if (!map || !map.pools.some((p) => p.mapPoolId === match.mapPoolId)) throw conflict('MAP_NOT_IN_POOL', 'That map is not part of the match map pool');

    await this.prisma.matchMap.update({ where: { id: matchMap.id }, data: { mapId, status: 'PENDING', scoreA: 0, scoreB: 0, startedAt: null } });
    if (match.status === 'LIVE') await this.lifecycle.cas(matchId, 'LIVE', 'CONFIGURING');
    await this.command(match, 'MATCH_CHANGE_MAP', { mapNumber, mapKey: map.key, workshopId: map.workshopId, reason }, ctx);
    await this.log(ctx, 'match.change_map', matchId, reason, { map: matchMap.map.name, mapNumber }, { map: map.name, mapNumber });
    this.lifecycle.emitUpdated(matchId);
  }

  // ─────────────── server ───────────────

  /** Moves the match to a specific server (explicit choice, may be a maintenance-held one). */
  async assignServer(matchId: string, serverId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['WAITING', 'LOBBY', 'MAP_FORCED', 'VETO', 'SERVER_ERROR']);
    const target = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!target) throw notFound('SERVER_NOT_FOUND', 'Server does not exist');
    if (target.currentMatchId && target.currentMatchId !== matchId) throw conflict('SERVER_IN_USE', 'That server hosts another match');
    const status = effectiveStatus(target, this.clock.now());
    if (target.id !== match.serverId && status !== 'READY' && status !== 'ONLINE') throw conflict('SERVER_NOT_AVAILABLE', `The server is ${status}`);

    const previousServerId = match.serverId;
    const stamp = this.clock.nowMs();
    const mapsDecided = (await this.prisma.matchMap.count({ where: { matchId } })) >= match.bestOf;
    await this.prisma.transact(async (tx) => {
      if (previousServerId && previousServerId !== serverId) {
        await this.commands.issue({ serverId: previousServerId, matchId, type: 'MATCH_CANCEL', payload: { matchId, reason: 'MOVED' }, idempotencyKey: `moved:${matchId}:${previousServerId}:${stamp}` }, tx);
        await this.allocator.release(matchId, tx);
      }
      await tx.server.update({ where: { id: serverId }, data: { status: 'IN_USE', currentMatchId: matchId, reservedUntil: new Date(stamp + 20 * 60_000) } });
      await tx.match.update({
        where: { id: matchId },
        data: { serverId, status: match.status === 'SERVER_ERROR' ? 'CONFIGURING' : match.status === 'WAITING' ? (mapsDecided ? 'MAP_FORCED' : 'LOBBY') : match.status },
      });
    });
    const type = match.status === 'SERVER_ERROR' ? 'MATCH_START' : 'MATCH_PREPARE';
    await this.commands.issue({ serverId, matchId, type, payload: { config: await this.config.build(matchId) }, issuedById: ctx.actorUserId, idempotencyKey: `${type.toLowerCase()}:${matchId}:${serverId}:${stamp}` });
    await this.log(ctx, 'match.assign_server', matchId, reason, { serverId: previousServerId }, { serverId });
    this.lifecycle.emitUpdated(matchId);
  }

  // ─────────────── teams and players ───────────────

  /** Moves a player between TEAM A, TEAM B and UNASSIGNED. Teams are independent: each has its own size limit. */
  async assignTeam(matchId: string, userId: string, team: TeamSlot | null, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, MATCH_SETUP_STATUSES as MatchStatus[]);
    const player = await this.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId, userId } }, include: { matchTeam: true, user: { select: { displayName: true } } } });
    if (!player || player.removedAt) throw notFound('NOT_IN_MATCH', 'That player is not part of the match');

    const before = player.matchTeam?.slot ?? null;
    if (before === team) return;
    await this.prisma.transact(async (tx) => {
      let target: { id: string } | null = null;
      if (team) {
        const row = await tx.matchTeam.findUnique({ where: { matchId_slot: { matchId, slot: team } } });
        if (!row) throw conflict('TEAM_MISSING', `Team ${team} does not exist`);
        const starters = await tx.matchPlayer.count({ where: { matchTeamId: row.id, removedAt: null, isSubstitute: false, NOT: { id: player.id } } });
        if (starters >= row.maxPlayers) throw conflict('TEAM_FULL', `Team ${team} is full (${row.maxPlayers} players)`);
        target = row;
      }
      await tx.matchPlayer.update({ where: { id: player.id }, data: { matchTeamId: target?.id ?? null, isSubstitute: false, isCaptain: false, connectedAt: null } });
      for (const teamId of [player.matchTeamId, target?.id].filter((id): id is string => !!id)) await this.ensureCaptain(tx, matchId, teamId, match.mode);
    });
    await this.syncPlayerToServer(match, player.steamId, team, reason, ctx);
    await this.log(ctx, 'match.assign_team', matchId, reason, { player: player.user.displayName, team: before }, { player: player.user.displayName, team });
    this.lifecycle.emitUpdated(matchId);
  }

  /** Adds a player to the match lobby. In tournament matches only substitutes may be added, and only by admins. */
  async addPlayer(matchId: string, input: { userId?: string; steamId?: string; team: TeamSlot | null }, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, OPEN_STATUSES);
    const user = await this.prisma.user.findFirst({ where: input.userId ? { id: input.userId } : { steamId: input.steamId } });
    if (!user) throw notFound('USER_NOT_FOUND', 'That player has not signed in to the platform yet');
    if (await this.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId, userId: user.id } } })) {
      throw conflict('ALREADY_IN_MATCH', 'That player is already part of the match');
    }
    const banned = await this.prisma.ban.findFirst({ where: { userId: user.id, type: 'PLATFORM', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }] } });
    if (banned) throw forbidden('That player is banned from the platform', 'PLAYER_BANNED');

    const running = !(MATCH_SETUP_STATUSES as MatchStatus[]).includes(match.status);
    if (match.kind === 'TOURNAMENT' && ctx.role !== 'ADMIN') throw forbidden('Only admins can change tournament line-ups', 'TOURNAMENT_LINEUP_LOCKED');
    const asSubstitute = running || match.kind === 'TOURNAMENT';
    if (asSubstitute && !input.team) throw badRequest('TEAM_REQUIRED', 'A substitute needs a team');

    await this.prisma.transact(async (tx) => {
      let teamId: string | null = null;
      if (input.team) {
        const row = await tx.matchTeam.findUnique({ where: { matchId_slot: { matchId, slot: input.team } } });
        if (!row) throw conflict('TEAM_MISSING', `Team ${input.team} does not exist`);
        if (!asSubstitute) {
          const starters = await tx.matchPlayer.count({ where: { matchTeamId: row.id, removedAt: null, isSubstitute: false } });
          if (starters >= row.maxPlayers) throw conflict('TEAM_FULL', `Team ${input.team} is full (${row.maxPlayers} players)`);
        }
        teamId = row.id;
      }
      await tx.matchPlayer.create({ data: { matchId, matchTeamId: teamId, userId: user.id, steamId: user.steamId, mode: match.mode, isSubstitute: asSubstitute } });
      if (teamId) await this.ensureCaptain(tx, matchId, teamId, match.mode);
    });
    if (input.team) await this.syncPlayerToServer(match, user.steamId, input.team, reason, ctx);
    await this.log(ctx, 'match.add_player', matchId, reason, undefined, { player: user.displayName, team: input.team, substitute: asSubstitute });
    this.lifecycle.emitUpdated(matchId);
  }

  async removePlayer(matchId: string, userId: string, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, OPEN_STATUSES);
    const player = await this.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId, userId } }, include: { matchTeam: true, user: { select: { displayName: true } } } });
    if (!player || player.removedAt) throw notFound('NOT_IN_MATCH', 'That player is not part of the match');
    if (match.kind === 'TOURNAMENT' && ctx.role !== 'ADMIN') throw forbidden('Only admins can change tournament line-ups', 'TOURNAMENT_LINEUP_LOCKED');

    await this.prisma.transact(async (tx) => {
      await tx.matchPlayer.update({ where: { id: player.id }, data: { removedAt: this.clock.now(), removalReason: (reason ?? 'removed by controller').slice(0, 200), isCaptain: false } });
      if (player.matchTeamId) await this.ensureCaptain(tx, matchId, player.matchTeamId, match.mode);
    });
    await this.command(match, 'MATCH_REMOVE_PLAYER', { steamId: player.steamId, reason }, ctx, false);
    await this.log(ctx, 'match.remove_player', matchId, reason, { player: player.user.displayName, team: player.matchTeam?.slot ?? null }, { removed: true });
    this.lifecycle.emitUpdated(matchId);
  }

  /** Bans a player from this match only (platform bans are issued in the player administration). */
  async banFromMatch(matchId: string, userId: string, reason: string, ctx: ControlCtx): Promise<void> {
    await this.removePlayer(matchId, userId, `Banned: ${reason}`, ctx);
    await this.prisma.ban.create({ data: { userId, matchId, type: 'MATCH', reason, issuedById: ctx.actorUserId } });
    await this.log(ctx, 'match.ban', matchId, reason);
  }

  /** Lifts a match penalty (team-damage removal or match ban) and lets the player back in. */
  async pardon(matchId: string, userId: string, reason: string, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, OPEN_STATUSES);
    const player = await this.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId, userId } }, include: { user: { select: { displayName: true } } } });
    if (!player) throw notFound('NOT_IN_MATCH', 'That player is not part of the match');
    const lifted = await this.prisma.ban.updateMany({ where: { userId, matchId, type: 'MATCH', revokedAt: null }, data: { revokedAt: this.clock.now(), revokedById: ctx.actorUserId, revokeReason: reason } });
    await this.prisma.matchPlayer.update({ where: { id: player.id }, data: { removedAt: null, removalReason: null } });
    await this.command(match, 'MATCH_PARDON_PLAYER', { steamId: player.steamId, reason }, ctx, false);
    await this.log(ctx, 'match.pardon', matchId, reason, { player: player.user.displayName, bans: lifted.count, removed: player.removedAt !== null }, { removed: false });
    this.lifecycle.emitUpdated(matchId);
  }

  // ─────────────── match configuration ───────────────

  /** Changes bo-format, map pool, team sizes or names. Only while the match is being set up. */
  async updateConfig(matchId: string, input: UpdateMatchConfigInput, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, MATCH_SETUP_STATUSES as MatchStatus[]);
    if (match.kind === 'TOURNAMENT' && ctx.role !== 'ADMIN') throw forbidden('Only admins can change tournament matches', 'TOURNAMENT_LINEUP_LOCKED');
    const teams = await this.prisma.matchTeam.findMany({ where: { matchId }, include: { players: { where: { removedAt: null, isSubstitute: false } } } });

    const changes: Record<string, unknown> = {};
    await this.prisma.transact(async (tx) => {
      const data: Record<string, unknown> = {};
      if (input.bestOf !== undefined && input.bestOf !== match.bestOf) {
        data.bestOf = input.bestOf;
        await tx.matchMap.deleteMany({ where: { matchId, status: 'PENDING' } }); // map slots change: decide again
        changes.bestOf = { from: match.bestOf, to: input.bestOf };
      }
      if (input.mapPoolId !== undefined && input.mapPoolId !== match.mapPoolId) {
        if (!(await tx.mapPool.findUnique({ where: { id: input.mapPoolId } }))) throw notFound('MAP_POOL_NOT_FOUND', 'Map pool does not exist');
        data.mapPoolId = input.mapPoolId;
        await tx.matchMap.deleteMany({ where: { matchId, status: 'PENDING' } });
        changes.mapPoolId = { from: match.mapPoolId, to: input.mapPoolId };
      }
      if (Object.keys(data).length > 0) {
        // Changing format or pool invalidates earlier map decisions and any veto in progress.
        await tx.matchVetoAction.deleteMany({ where: { matchId } });
        await tx.match.update({ where: { id: matchId }, data: { ...data, vetoConfig: null as never, vetoStartsWith: null, vetoDeadline: null, ...(match.status === 'VETO' || match.status === 'MAP_FORCED' ? { status: match.serverId ? 'LOBBY' : 'WAITING' } : {}) } });
      }
      for (const [slot, max, name] of [['A', input.teamAMax, input.teamAName], ['B', input.teamBMax, input.teamBName]] as const) {
        const team = teams.find((t) => t.slot === slot);
        if (!team) continue;
        if (max !== undefined && max !== team.maxPlayers) {
          if (max < team.players.length) throw conflict('TEAM_TOO_SMALL', `Team ${slot} already has ${team.players.length} players; remove some first`);
          await tx.matchTeam.update({ where: { id: team.id }, data: { maxPlayers: max } });
          changes[`team${slot}Max`] = { from: team.maxPlayers, to: max };
        }
        if (name !== undefined && name !== team.name) {
          await tx.matchTeam.update({ where: { id: team.id }, data: { name } });
          changes[`team${slot}Name`] = { from: team.name, to: name };
        }
      }
    });
    if (Object.keys(changes).length === 0) return;
    await this.log(ctx, 'match.config_change', matchId, input.reason, Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, (v as { from: unknown }).from])), Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, (v as { to: unknown }).to])));
    this.lifecycle.emitUpdated(matchId);
  }

  async editScore(matchId: string, input: { mapNumber: number; scoreA: number; scoreB: number; reason: string }, ctx: ControlCtx): Promise<void> {
    const match = await this.requireMatch(matchId, ['LIVE', 'SERVER_ERROR']);
    const map = await this.prisma.matchMap.findUnique({ where: { matchId_mapNumber: { matchId, mapNumber: input.mapNumber } } });
    if (!map) throw notFound('MAP_NOT_FOUND', `This match has no map ${input.mapNumber}`);
    if (map.status === 'FINISHED') throw conflict('MAP_FINISHED', 'A finished map cannot be edited');
    await this.prisma.matchMap.update({ where: { id: map.id }, data: { scoreA: input.scoreA, scoreB: input.scoreB } });
    await this.command(match, 'MATCH_SET_SCORE', { mapNumber: input.mapNumber, scoreA: input.scoreA, scoreB: input.scoreB, reason: input.reason }, ctx);
    await this.log(ctx, 'match.edit_score', matchId, input.reason, { mapNumber: input.mapNumber, scoreA: map.scoreA, scoreB: map.scoreB }, { scoreA: input.scoreA, scoreB: input.scoreB });
    this.events.emit(DomainEvent.MatchScore, { matchId } satisfies MatchEventPayload);
    this.lifecycle.emitUpdated(matchId);
  }

  /** Sets the winner by decision (no Elo). The bracket advances. */
  async decide(matchId: string, winner: TeamSlot, reason: string, ctx: ControlCtx): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { status: true } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (!(await this.finalizer.decide(matchId, winner, reason))) throw conflict('MATCH_CLOSED', `The match is already ${match.status}`);
    await this.log(ctx, 'match.decide', matchId, reason, { state: match.status }, { state: 'FINISHED', winner });
  }

  // ─────────────── helpers ───────────────

  private async ensureCaptain(tx: Parameters<Parameters<PrismaService['transact']>[0]>[0], matchId: string, matchTeamId: string, mode: Match['mode']): Promise<void> {
    const starters = await tx.matchPlayer.findMany({ where: { matchTeamId, removedAt: null, isSubstitute: false }, orderBy: { id: 'asc' } });
    if (starters.length > 0 && !starters.some((p) => p.isCaptain)) await tx.matchPlayer.update({ where: { id: starters[0]!.id }, data: { isCaptain: true } });
    await this.factory.refreshAverageElo(tx, matchTeamId, mode);
    void matchId;
  }

  private async syncPlayerToServer(match: Match, steamId: string, team: TeamSlot | null, reason: string | undefined, ctx: ControlCtx): Promise<void> {
    if (!match.serverId || ['SCHEDULED', 'WAITING'].includes(match.status)) return;
    await this.commands.issue({ serverId: match.serverId, matchId: match.id, type: 'MATCH_FORCE_TEAM', payload: { steamId, team, reason }, issuedById: ctx.actorUserId });
  }

  private async requireMatch(matchId: string, allowed: MatchStatus[]): Promise<Match> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (!allowed.includes(match.status)) throw conflict('INVALID_MATCH_STATE', `This action is not possible while the match is ${match.status}`);
    return match;
  }

  private async requireServerReachable(serverId: string | null): Promise<void> {
    if (!serverId) throw conflict('NO_SERVER', 'The match has no server');
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server || effectiveStatus(server, this.clock.now()) === 'OFFLINE') throw conflict('SERVER_OFFLINE', 'The server is offline; assign another server first');
  }

  private async command(match: { id: string; serverId: string | null }, type: Parameters<MatchCommandService['issue']>[0]['type'], payload: Record<string, unknown>, ctx: ControlCtx, requireServer = true): Promise<void> {
    if (!match.serverId) {
      if (requireServer) throw badRequest('NO_SERVER', 'The match has no server yet');
      return;
    }
    await this.commands.issue({ serverId: match.serverId, matchId: match.id, type, payload, issuedById: ctx.actorUserId });
  }

  private log(ctx: ControlCtx, action: string, matchId: string, reason: string | undefined | null, oldValue?: unknown, newValue?: unknown): Promise<void> {
    return this.audit.record({
      actor: ctx.actor,
      action,
      targetType: 'match',
      targetId: matchId,
      reason: reason ?? null,
      oldValue,
      newValue,
      metadata: { role: ctx.role },
      ip: ctx.ip,
    });
  }
}
