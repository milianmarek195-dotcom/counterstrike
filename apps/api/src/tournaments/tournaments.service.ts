import { randomInt } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { Prisma, isUniqueViolation, type Tournament } from '@celtist/database';
import {
  SUPPORTED_TOURNAMENT_FORMATS,
  assertTransition,
  displayMatchStatus,
  TOURNAMENT_TRANSITIONS,
  type CreateTournamentInput,
  type TournamentFormat,
  type UpdateTournamentInput,
  type GameMode,
} from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload, type TournamentEventPayload } from '../common/domain-events.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { hashSecret, verifySecret } from '../common/password.js';
import { PrismaService } from '../database/prisma.service.js';
import { MapsService } from '../maps/maps.service.js';
import { MatchLifecycleService } from '../matches/match-lifecycle.service.js';
import { BracketProgressionService } from './bracket-progression.service.js';

export interface Actor {
  audit: AuditActor;
  userId: string | null;
  ip?: string | null;
}

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly maps: MapsService,
    private readonly progression: BracketProgressionService,
    private readonly lifecycle: MatchLifecycleService,
    private readonly events: EventEmitter2,
  ) {}

  // ─────────────── reads ───────────────

  async list(query: { status?: 'upcoming' | 'running' | 'finished'; mode?: GameMode; page: number; pageSize: number }, includePrivate: boolean) {
    const where: Prisma.TournamentWhereInput = {
      ...(includePrivate ? {} : { visibility: 'PUBLIC', status: { not: 'DRAFT' } }),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.status === 'upcoming' ? { status: { in: includePrivate ? ['DRAFT', 'SCHEDULED'] : ['SCHEDULED'] } } : {}),
      ...(query.status === 'running' ? { status: { in: ['RUNNING', 'PAUSED'] } } : {}),
      ...(query.status === 'finished' ? { status: { in: ['FINISHED', 'CANCELLED'] } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.tournament.count({ where }),
      this.prisma.tournament.findMany({
        where,
        orderBy: query.status === 'finished' ? { finishedAt: 'desc' } : { startsAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { teams: true, registrations: true } } },
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, tournaments: rows.map((t) => this.summary(t, t._count.teams, t._count.registrations)) };
  }

  async get(id: string, viewerUserId?: string, canSeePrivate = false) {
    const t = await this.prisma.tournament.findUnique({
      where: { id },
      include: {
        mapPool: { include: { maps: { include: { map: true }, orderBy: { position: 'asc' } } } },
        teams: { include: { members: { include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } } } }, orderBy: [{ seed: 'asc' }, { name: 'asc' }] },
        servers: { include: { server: { select: { id: true, name: true, region: true } } } },
        _count: { select: { registrations: true } },
      },
    });
    if (!t || (t.status === 'DRAFT' && !canSeePrivate)) throw notFound('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    if (t.visibility === 'PRIVATE' && !canSeePrivate) {
      const member = viewerUserId ? t.teams.some((team) => team.members.some((m) => m.userId === viewerUserId)) : false;
      const registered = viewerUserId ? (await this.prisma.tournamentRegistration.count({ where: { tournamentId: id, userId: viewerUserId } })) > 0 : false;
      if (!member && !registered) {
        // Private tournaments show only the basics until you are in.
        return { ...this.summary(t, t.teams.length, t._count.registrations), private: true, requiresPassword: t.passwordHash !== null };
      }
    }
    const myRegistration = viewerUserId ? await this.prisma.tournamentRegistration.findUnique({ where: { tournamentId_userId: { tournamentId: id, userId: viewerUserId } } }) : null;
    return {
      ...this.summary(t, t.teams.length, t._count.registrations),
      description: t.description,
      rules: t.rules,
      requiresPassword: t.passwordHash !== null,
      mapPool: { id: t.mapPool.id, name: t.mapPool.name, maps: t.mapPool.maps.map((m) => ({ id: m.map.id, key: m.map.key, name: m.map.name })) },
      servers: t.servers.map((s) => s.server),
      teams: t.teams.map((team) => ({
        id: team.id,
        name: team.name,
        seed: team.seed,
        averageElo: team.averageElo,
        status: team.status,
        placement: team.placement,
        members: team.members.map((m) => ({ ...m.user, role: m.role })),
      })),
      viewer: viewerUserId ? { registered: myRegistration !== null, inTeam: t.teams.some((team) => team.members.some((m) => m.userId === viewerUserId)) } : null,
    };
  }

  /** Bracket for display: every node with its teams, status, score and winner. */
  async bracket(id: string) {
    const t = await this.prisma.tournament.findUnique({ where: { id }, select: { id: true, status: true, format: true, settings: true } });
    if (!t || t.status === 'DRAFT') throw notFound('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    const nodes = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId: id },
      include: {
        teamA: { select: { id: true, name: true, seed: true } },
        teamB: { select: { id: true, name: true, seed: true } },
        match: { select: { id: true, status: true, bestOf: true, teams: { select: { slot: true, seriesScore: true } }, maps: { select: { mapNumber: true, status: true, map: { select: { name: true } } }, orderBy: { mapNumber: 'asc' } } } },
      },
      orderBy: [{ side: 'asc' }, { round: 'asc' }, { position: 'asc' }],
    });
    return {
      tournamentId: id,
      format: t.format,
      status: t.status,
      nodes: nodes.map((n) => ({
        key: n.key,
        side: n.side,
        round: n.round,
        position: n.position,
        label: n.label,
        isBye: n.isBye,
        matchId: n.matchId,
        status: n.match ? displayMatchStatus(n.match.status) : n.isBye ? 'BYE' : 'SCHEDULED',
        teamA: n.teamA,
        teamB: n.teamB,
        scoreA: n.match?.teams.find((x) => x.slot === 'A')?.seriesScore ?? null,
        scoreB: n.match?.teams.find((x) => x.slot === 'B')?.seriesScore ?? null,
        winnerId: n.winnerId,
        map: n.match?.maps.find((m) => m.status === 'LIVE')?.map.name ?? n.match?.maps[0]?.map.name ?? null,
        winnerNext: n.winnerNextId,
        loserNext: n.loserNextId,
      })),
    };
  }

  // ─────────────── create / edit ───────────────

  async create(input: CreateTournamentInput, actor: Actor): Promise<Tournament> {
    if (!SUPPORTED_TOURNAMENT_FORMATS.includes(input.format as TournamentFormat)) {
      throw badRequest('FORMAT_NOT_SUPPORTED', `The format ${input.format} is not available yet`);
    }
    const pool = input.mapPoolId ? await this.maps.poolOrThrow(input.mapPoolId) : await this.maps.defaultPoolFor(input.mode);
    await this.assertTemplate(input.vetoTemplateId ?? null, input.bestOf, pool.maps.length);
    await this.assertServers(input.serverIds);

    const tournament = await this.prisma.tournament.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        rules: input.rules ?? null,
        format: input.format as TournamentFormat,
        mode: input.mode,
        teamSize: input.teamSize,
        maxTeams: input.maxTeams,
        minTeams: input.minTeams,
        bestOf: input.bestOf,
        bestOfFinal: input.bestOfFinal ?? null,
        grandFinalReset: input.grandFinalReset,
        seedingMethod: input.seedingMethod,
        visibility: input.visibility,
        registrationOpen: input.registrationOpen,
        allowSubstitutes: input.allowSubstitutes,
        substitutesPerTeam: input.substitutesPerTeam,
        minElo: input.minElo ?? null,
        maxElo: input.maxElo ?? null,
        passwordHash: input.password ? await hashSecret(input.password) : null,
        startsAt: input.startsAt,
        mapPoolId: pool.id,
        vetoTemplateId: input.vetoTemplateId ?? null,
        settings: { thirdPlaceMatch: input.thirdPlaceMatch },
        createdById: actor.userId,
        servers: { create: input.serverIds.map((serverId) => ({ serverId })) },
      },
    });
    await this.audit.record({ actor: actor.audit, action: 'tournament.create', targetType: 'tournament', targetId: tournament.id, targetLabel: tournament.name, newValue: { ...input, password: input.password ? '[set]' : null }, ip: actor.ip });
    this.events.emit(DomainEvent.TournamentCreated, { tournamentId: tournament.id } satisfies TournamentEventPayload);
    return tournament;
  }

  async update(id: string, input: UpdateTournamentInput, actor: Actor): Promise<Tournament> {
    const before = await this.require(id);
    const structural = ['maxTeams', 'minTeams', 'bestOf', 'bestOfFinal', 'seedingMethod', 'mapPoolId', 'vetoTemplateId', 'serverIds'] as const;
    if (!['DRAFT', 'SCHEDULED'].includes(before.status) && structural.some((k) => input[k] !== undefined)) {
      throw conflict('TOURNAMENT_LOCKED', 'Format, bracket and map settings cannot change after the tournament started');
    }
    if (['FINISHED', 'CANCELLED'].includes(before.status)) throw conflict('TOURNAMENT_CLOSED', `The tournament is ${before.status}`);

    const bestOf = input.bestOf ?? before.bestOf;
    const poolId = input.mapPoolId ?? before.mapPoolId;
    const pool = await this.maps.poolOrThrow(poolId);
    const templateId = input.vetoTemplateId === undefined ? before.vetoTemplateId : input.vetoTemplateId;
    if (input.bestOf || input.mapPoolId || input.vetoTemplateId !== undefined) await this.assertTemplate(templateId, bestOf as 1 | 3 | 5, pool.maps.length);
    if (input.serverIds) await this.assertServers(input.serverIds);
    const minTeams = input.minTeams ?? before.minTeams;
    const maxTeams = input.maxTeams ?? before.maxTeams;
    if (minTeams > maxTeams) throw badRequest('INVALID_TEAM_LIMITS', 'minTeams must not exceed maxTeams');
    if (before.format === 'DOUBLE_ELIMINATION' && minTeams < 3) throw badRequest('INVALID_TEAM_LIMITS', 'Double elimination needs at least 3 teams');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.serverIds) {
        await tx.tournamentServer.deleteMany({ where: { tournamentId: id } });
        await tx.tournamentServer.createMany({ data: input.serverIds.map((serverId) => ({ tournamentId: id, serverId })) });
      }
      return tx.tournament.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.rules !== undefined ? { rules: input.rules } : {}),
          ...(input.maxTeams !== undefined ? { maxTeams: input.maxTeams } : {}),
          ...(input.minTeams !== undefined ? { minTeams: input.minTeams } : {}),
          ...(input.bestOf !== undefined ? { bestOf: input.bestOf } : {}),
          ...(input.bestOfFinal !== undefined ? { bestOfFinal: input.bestOfFinal } : {}),
          ...(input.seedingMethod !== undefined ? { seedingMethod: input.seedingMethod } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.registrationOpen !== undefined ? { registrationOpen: input.registrationOpen } : {}),
          ...(input.allowSubstitutes !== undefined ? { allowSubstitutes: input.allowSubstitutes } : {}),
          ...(input.substitutesPerTeam !== undefined ? { substitutesPerTeam: input.substitutesPerTeam } : {}),
          ...(input.minElo !== undefined ? { minElo: input.minElo } : {}),
          ...(input.maxElo !== undefined ? { maxElo: input.maxElo } : {}),
          ...(input.password !== undefined ? { passwordHash: input.password ? await hashSecret(input.password) : null } : {}),
          ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
          ...(input.mapPoolId !== undefined ? { mapPoolId: input.mapPoolId } : {}),
          ...(input.vetoTemplateId !== undefined ? { vetoTemplateId: input.vetoTemplateId } : {}),
        },
      });
    });
    await this.audit.record({
      actor: actor.audit,
      action: 'tournament.edit',
      targetType: 'tournament',
      targetId: id,
      targetLabel: updated.name,
      oldValue: pickChanged(before, input),
      newValue: { ...input, password: input.password ? '[set]' : input.password },
      ip: actor.ip,
    });
    this.emitUpdated(id);
    return updated;
  }

  /** DRAFT → SCHEDULED: visible to everybody; registration may open. */
  async publish(id: string, actor: Actor): Promise<void> {
    await this.transition(id, 'SCHEDULED', 'tournament.publish', actor);
  }

  async delete(id: string, actor: Actor): Promise<void> {
    const t = await this.require(id);
    if (!['DRAFT', 'SCHEDULED'].includes(t.status)) throw conflict('TOURNAMENT_STARTED', 'A started tournament cannot be deleted; cancel it instead');
    await this.prisma.tournament.delete({ where: { id } });
    await this.audit.record({ actor: actor.audit, action: 'tournament.delete', targetType: 'tournament', targetId: id, targetLabel: t.name, oldValue: { name: t.name, status: t.status }, ip: actor.ip });
  }

  // ─────────────── start / pause / cancel ───────────────

  /** SCHEDULED → RUNNING: seeds teams, generates the bracket and releases the first matches. */
  async start(id: string, actor: Actor): Promise<{ matches: number }> {
    const t = await this.require(id);
    assertTransition('tournament', TOURNAMENT_TRANSITIONS, t.status, 'RUNNING');

    const teams = await this.prisma.tournamentTeam.findMany({ where: { tournamentId: id, status: { in: ['CONFIRMED', 'PENDING'] } }, include: { members: true } });
    const eligible = teams.filter((team) => team.members.filter((m) => m.role !== 'SUBSTITUTE').length >= t.teamSize);
    if (eligible.length < t.minTeams) {
      throw conflict('NOT_ENOUGH_TEAMS', `At least ${t.minTeams} complete teams are required (${eligible.length} ready)`, {
        incomplete: teams.filter((x) => !eligible.includes(x)).map((x) => x.name),
      });
    }
    if (eligible.length > t.maxTeams) throw conflict('TOO_MANY_TEAMS', `The tournament allows ${t.maxTeams} teams`);

    let readyMatchIds: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tournament.updateMany({ where: { id, status: 'SCHEDULED' }, data: { status: 'RUNNING', startedAt: this.clock.now(), registrationOpen: false } });
      if (claimed.count === 0) throw conflict('STATE_CHANGED', 'The tournament state changed, try again');
      await tx.tournamentTeam.updateMany({ where: { tournamentId: id, id: { notIn: eligible.map((e) => e.id) } }, data: { status: 'WITHDRAWN' } });
      await tx.tournamentTeam.updateMany({ where: { id: { in: eligible.map((e) => e.id) } }, data: { status: 'CONFIRMED' } });

      const seeded = this.seed(eligible, t.seedingMethod);
      for (const [index, team] of seeded.entries()) await tx.tournamentTeam.update({ where: { id: team.id }, data: { seed: index + 1 } });
      const fresh = await tx.tournament.findUniqueOrThrow({ where: { id } });
      const withSeeds = seeded.map((team, index) => ({ ...team, seed: index + 1 }));
      const outcome = await this.progression.build(tx, fresh, withSeeds.map((tm) => ({ id: tm.id, teamId: tm.teamId, name: tm.name, seed: tm.seed, members: tm.members.map((m) => ({ userId: m.userId, role: m.role })) })));
      readyMatchIds = outcome.readyMatchIds;
      await this.audit.record({ actor: actor.audit, action: 'tournament.start', targetType: 'tournament', targetId: id, targetLabel: t.name, newValue: { teams: seeded.length, matches: readyMatchIds.length }, ip: actor.ip }, tx);
    });

    for (const matchId of readyMatchIds) this.events.emit(DomainEvent.MatchReadyToSchedule, { matchId, tournamentId: id } satisfies MatchEventPayload);
    this.events.emit(DomainEvent.TournamentBracket, { tournamentId: id } satisfies TournamentEventPayload);
    this.emitUpdated(id);
    return { matches: readyMatchIds.length };
  }

  /** Pausing stops the automation (no new servers); running matches finish normally. */
  async pause(id: string, actor: Actor): Promise<void> {
    await this.transition(id, 'PAUSED', 'tournament.pause', actor);
  }

  async resume(id: string, actor: Actor): Promise<void> {
    await this.transition(id, 'RUNNING', 'tournament.resume', actor);
    const waiting = await this.prisma.tournamentMatch.findMany({ where: { tournamentId: id, match: { status: { in: ['SCHEDULED', 'WAITING'] }, teams: { some: {} } } }, select: { matchId: true } });
    for (const { matchId } of waiting) if (matchId) this.events.emit(DomainEvent.MatchReadyToSchedule, { matchId, tournamentId: id } satisfies MatchEventPayload);
  }

  async cancel(id: string, reason: string, actor: Actor): Promise<void> {
    const t = await this.require(id);
    assertTransition('tournament', TOURNAMENT_TRANSITIONS, t.status, 'CANCELLED');
    await this.prisma.tournament.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: this.clock.now(), registrationOpen: false } });
    const open = await this.prisma.match.findMany({ where: { tournamentMatch: { tournamentId: id }, status: { notIn: ['FINISHED', 'CANCELLED'] } }, select: { id: true } });
    for (const { id: matchId } of open) await this.lifecycle.cancel(matchId, `TOURNAMENT_CANCELLED: ${reason}`);
    await this.audit.record({ actor: actor.audit, action: 'tournament.cancel', targetType: 'tournament', targetId: id, targetLabel: t.name, reason, oldValue: { status: t.status }, newValue: { status: 'CANCELLED' }, ip: actor.ip });
    this.emitUpdated(id);
  }

  // ─────────────── helpers ───────────────

  async require(id: string): Promise<Tournament> {
    const t = await this.prisma.tournament.findUnique({ where: { id } });
    if (!t) throw notFound('TOURNAMENT_NOT_FOUND', 'Tournament does not exist');
    return t;
  }

  private async transition(id: string, to: Tournament['status'], action: string, actor: Actor): Promise<void> {
    const t = await this.require(id);
    assertTransition('tournament', TOURNAMENT_TRANSITIONS, t.status, to);
    const moved = await this.prisma.tournament.updateMany({ where: { id, status: t.status }, data: { status: to } });
    if (moved.count === 0) throw conflict('STATE_CHANGED', 'The tournament state changed, try again');
    await this.audit.record({ actor: actor.audit, action, targetType: 'tournament', targetId: id, targetLabel: t.name, oldValue: { status: t.status }, newValue: { status: to }, ip: actor.ip });
    this.emitUpdated(id);
  }

  private seed<T extends { averageElo: number; seed: number | null; id: string }>(teams: T[], method: Tournament['seedingMethod']): T[] {
    const list = [...teams];
    if (method === 'ELO') return list.sort((a, b) => b.averageElo - a.averageElo || a.id.localeCompare(b.id));
    if (method === 'MANUAL') {
      if (list.some((t) => t.seed === null)) throw badRequest('SEEDS_MISSING', 'Manual seeding needs a seed for every team');
      const seeds = list.map((t) => t.seed!);
      if (new Set(seeds).size !== seeds.length) throw badRequest('SEEDS_DUPLICATE', 'Seeds must be unique');
      return list.sort((a, b) => a.seed! - b.seed!);
    }
    for (let i = list.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  }

  private async assertTemplate(templateId: string | null, bestOf: 1 | 3 | 5, mapCount: number): Promise<void> {
    if (!templateId) return;
    const template = await this.prisma.vetoTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw notFound('VETO_TEMPLATE_NOT_FOUND', 'Veto template does not exist');
    if (template.bestOf !== bestOf) throw badRequest('TEMPLATE_BEST_OF_MISMATCH', `The template is for best-of-${template.bestOf}`);
    const steps = template.steps as Array<{ action: string }>;
    const used = steps.filter((s) => s.action === 'BAN' || s.action === 'PICK').length + 1;
    if (used !== mapCount) throw badRequest('TEMPLATE_POOL_MISMATCH', `The template uses ${used} maps but the map pool has ${mapCount}`);
  }

  private async assertServers(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.server.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) throw badRequest('UNKNOWN_SERVER', 'One or more servers do not exist');
  }

  summary(t: Tournament, teamCount: number, registrationCount: number) {
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      format: t.format,
      mode: t.mode,
      teamSize: t.teamSize,
      maxTeams: t.maxTeams,
      minTeams: t.minTeams,
      bestOf: t.bestOf,
      bestOfFinal: t.bestOfFinal,
      visibility: t.visibility,
      registrationOpen: t.registrationOpen,
      minElo: t.minElo,
      maxElo: t.maxElo,
      startsAt: t.startsAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      teamCount,
      registrationCount,
    };
  }

  async verifyPassword(t: Pick<Tournament, 'passwordHash'>, password?: string): Promise<void> {
    if (!t.passwordHash) return;
    if (!password || !(await verifySecret(password, t.passwordHash))) throw forbidden('Wrong tournament password', 'WRONG_PASSWORD');
  }

  emitUpdated(tournamentId: string): void {
    this.events.emit(DomainEvent.TournamentUpdated, { tournamentId } satisfies TournamentEventPayload);
  }
}

function pickChanged(before: object, input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) if (key in before) out[key] = (before as Record<string, unknown>)[key];
  return out;
}

export { isUniqueViolation };
