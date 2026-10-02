import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isUniqueViolation, type Tournament, type TransactionClient } from '@celtist/database';
import { AuditService } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { type Actor, TournamentsService } from './tournaments.service.js';

type Role = 'CAPTAIN' | 'MEMBER' | 'SUBSTITUTE';

@Injectable()
export class TournamentTeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly tournaments: TournamentsService,
  ) {}

  // ─────────────── player self-service ───────────────

  /** Signs the player up alone (to be put into a team by the admins/auto-assign) or registers a whole team. */
  async register(tournamentId: string, userId: string, input: { password?: string; teamId?: string }): Promise<{ kind: 'REGISTRATION' | 'TEAM'; id: string }> {
    const t = await this.tournaments.require(tournamentId);
    this.assertOpen(t);
    await this.tournaments.verifyPassword(t, input.password);

    if (input.teamId) return this.registerTeam(t, userId, input.teamId);
    await this.assertEligible(t, [userId]);
    try {
      const rank = await this.prisma.playerRank.findUnique({ where: { userId_mode: { userId, mode: t.mode } } });
      const registration = await this.prisma.tournamentRegistration.create({ data: { tournamentId, userId, eloAtRegistration: rank?.elo ?? 1000 } });
      this.tournaments.emitUpdated(tournamentId);
      return { kind: 'REGISTRATION', id: registration.id };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('ALREADY_REGISTERED', 'You are already registered');
      throw error;
    }
  }

  private async registerTeam(t: Tournament, userId: string, teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, include: { members: true } });
    if (!team || team.disbandedAt) throw notFound('TEAM_NOT_FOUND', 'Team does not exist');
    if (team.captainId !== userId) throw forbidden('Only the team captain can register the team', 'NOT_CAPTAIN');
    if (team.mode !== t.mode) throw badRequest('MODE_MISMATCH', `This is a ${t.mode} tournament`);

    const starters = team.members.filter((m) => m.role !== 'SUBSTITUTE');
    if (starters.length < t.teamSize) throw conflict('TEAM_INCOMPLETE', `The team needs ${t.teamSize} players (it has ${starters.length})`);
    const roster = [
      ...starters.slice(0, t.teamSize).map((m) => ({ userId: m.userId, role: (m.userId === team.captainId ? 'CAPTAIN' : 'MEMBER') as Role })),
      ...(t.allowSubstitutes ? team.members.filter((m) => m.role === 'SUBSTITUTE').slice(0, t.substitutesPerTeam).map((m) => ({ userId: m.userId, role: 'SUBSTITUTE' as Role })) : []),
    ];
    await this.assertEligible(t, roster.map((r) => r.userId));
    const created = await this.createTeam(t, { name: team.name, teamId: team.id, logoUrl: team.logoUrl, members: roster });
    this.tournaments.emitUpdated(t.id);
    return { kind: 'TEAM' as const, id: created.id };
  }

  async withdraw(tournamentId: string, userId: string): Promise<void> {
    const t = await this.tournaments.require(tournamentId);
    if (!['DRAFT', 'SCHEDULED'].includes(t.status)) throw conflict('TOURNAMENT_STARTED', 'You cannot withdraw once the tournament has started; contact an admin');
    const registration = await this.prisma.tournamentRegistration.findUnique({ where: { tournamentId_userId: { tournamentId, userId } } });
    if (registration) {
      await this.prisma.tournamentRegistration.delete({ where: { id: registration.id } });
      this.tournaments.emitUpdated(tournamentId);
      return;
    }
    const membership = await this.prisma.tournamentTeamMember.findUnique({ where: { tournamentId_userId: { tournamentId, userId } }, include: { tournamentTeam: { include: { team: true } } } });
    if (!membership) throw notFound('NOT_REGISTERED', 'You are not registered for this tournament');
    const isCaptain = membership.role === 'CAPTAIN' || membership.tournamentTeam.team?.captainId === userId;
    if (!isCaptain) throw forbidden('Only the captain can withdraw the team', 'NOT_CAPTAIN');
    await this.prisma.tournamentTeam.delete({ where: { id: membership.tournamentTeamId } });
    this.tournaments.emitUpdated(tournamentId);
  }

  // ─────────────── administration ───────────────

  async listRegistrations(tournamentId: string) {
    await this.tournaments.require(tournamentId);
    const rows = await this.prisma.tournamentRegistration.findMany({
      where: { tournamentId, status: { not: 'WITHDRAWN' } },
      include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } },
      orderBy: { eloAtRegistration: 'desc' },
    });
    return rows.map((r) => ({ id: r.id, status: r.status, elo: r.eloAtRegistration, createdAt: r.createdAt, user: r.user }));
  }

  async adminAddTeam(tournamentId: string, input: { name: string; teamId?: string; members: Array<{ userId: string; role: Role }> }, actor: Actor) {
    const t = await this.requireEditable(tournamentId);
    this.assertRoster(t, input.members);
    await this.assertEligible(t, input.members.map((m) => m.userId), { skipElo: true });
    const team = await this.createTeam(t, { name: input.name, teamId: input.teamId ?? null, logoUrl: null, members: input.members });
    await this.audit.record({ actor: actor.audit, action: 'tournament.team.add', targetType: 'tournament', targetId: tournamentId, targetLabel: t.name, newValue: { team: input.name, members: input.members.length }, ip: actor.ip });
    this.tournaments.emitUpdated(tournamentId);
    return team;
  }

  async adminEditTeam(tournamentId: string, teamId: string, input: { name?: string; seed?: number | null; status?: 'PENDING' | 'CONFIRMED' | 'DISQUALIFIED' | 'WITHDRAWN'; members?: Array<{ userId: string; role: Role }> }, actor: Actor) {
    const t = await this.requireEditable(tournamentId);
    const before = await this.prisma.tournamentTeam.findFirst({ where: { id: teamId, tournamentId }, include: { members: true } });
    if (!before) throw notFound('TEAM_NOT_FOUND', 'Team is not part of this tournament');
    if (input.members) {
      this.assertRoster(t, input.members);
      await this.assertEligible(t, input.members.map((m) => m.userId), { skipElo: true, ignoreTeamId: teamId });
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.tournamentTeam.update({
          where: { id: teamId },
          data: {
            ...(input.name !== undefined ? { name: input.name, nameKey: input.name.trim().toLowerCase() } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
          },
        });
        if (input.members) {
          await tx.tournamentTeamMember.deleteMany({ where: { tournamentTeamId: teamId } });
          await tx.tournamentTeamMember.createMany({ data: input.members.map((m) => ({ tournamentId, tournamentTeamId: teamId, userId: m.userId, role: m.role })) });
          await this.updateAverageElo(tx, t, teamId);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('TEAM_CONFLICT', 'The team name or seed is already taken');
      throw error;
    }
    await this.audit.record({
      actor: actor.audit,
      action: 'tournament.team.edit',
      targetType: 'tournament',
      targetId: tournamentId,
      targetLabel: before.name,
      oldValue: { name: before.name, seed: before.seed, status: before.status, members: before.members.map((m) => ({ userId: m.userId, role: m.role })) },
      newValue: input,
      ip: actor.ip,
    });
    this.tournaments.emitUpdated(tournamentId);
  }

  async adminRemoveTeam(tournamentId: string, teamId: string, actor: Actor): Promise<void> {
    await this.requireEditable(tournamentId);
    const team = await this.prisma.tournamentTeam.findFirst({ where: { id: teamId, tournamentId } });
    if (!team) throw notFound('TEAM_NOT_FOUND', 'Team is not part of this tournament');
    await this.prisma.tournamentTeam.delete({ where: { id: teamId } });
    await this.audit.record({ actor: actor.audit, action: 'tournament.team.remove', targetType: 'tournament', targetId: tournamentId, targetLabel: team.name, ip: actor.ip });
    this.tournaments.emitUpdated(tournamentId);
  }

  /** Admin groups registered solo players into teams by hand. The first player of each group is the captain. */
  async assignPlayers(tournamentId: string, groups: Array<{ name: string; userIds: string[] }>, actor: Actor) {
    const t = await this.requireEditable(tournamentId);
    const all = groups.flatMap((g) => g.userIds);
    if (new Set(all).size !== all.length) throw badRequest('DUPLICATE_PLAYER', 'A player appears in more than one team');
    const registrations = await this.prisma.tournamentRegistration.findMany({ where: { tournamentId, userId: { in: all }, status: 'REGISTERED' } });
    if (registrations.length !== all.length) throw badRequest('NOT_REGISTERED', 'Only registered, unassigned players can be assigned');

    const created = [];
    for (const group of groups) {
      const members = group.userIds.map((userId, index) => ({ userId, role: roleFor(index, t.teamSize) }));
      this.assertRoster(t, members);
      created.push(await this.createTeam(t, { name: group.name, teamId: null, logoUrl: null, members }));
    }
    await this.prisma.tournamentRegistration.updateMany({ where: { tournamentId, userId: { in: all } }, data: { status: 'ASSIGNED' } });
    await this.audit.record({ actor: actor.audit, action: 'tournament.assign_players', targetType: 'tournament', targetId: tournamentId, targetLabel: t.name, newValue: { teams: groups.length, players: all.length }, ip: actor.ip });
    this.tournaments.emitUpdated(tournamentId);
    return created;
  }

  /**
   * Builds balanced teams from the registered solo players. BALANCED sorts by Elo and deals the players out in a
   * snake order (1…k, k…1) so team averages end up close together; RANDOM shuffles. Leftover players stay registered.
   */
  async autoAssign(tournamentId: string, strategy: 'BALANCED' | 'RANDOM', actor: Actor) {
    const t = await this.requireEditable(tournamentId);
    const existing = await this.prisma.tournamentTeam.count({ where: { tournamentId } });
    const registrations = await this.prisma.tournamentRegistration.findMany({ where: { tournamentId, status: 'REGISTERED' } });
    const slots = Math.max(0, t.maxTeams - existing);
    const teamCount = Math.min(Math.floor(registrations.length / t.teamSize), slots);
    if (teamCount < 1) throw conflict('NOT_ENOUGH_PLAYERS', `Need at least ${t.teamSize} registered players (and a free team slot) to form a team`);

    let pool = [...registrations];
    if (strategy === 'RANDOM') {
      for (let i = pool.length - 1; i > 0; i--) {
        const j = randomInt(0, i + 1);
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
    } else {
      pool.sort((a, b) => b.eloAtRegistration - a.eloAtRegistration || a.userId.localeCompare(b.userId));
    }
    pool = pool.slice(0, teamCount * t.teamSize);

    const groups: string[][] = Array.from({ length: teamCount }, () => []);
    pool.forEach((registration, index) => {
      const round = Math.floor(index / teamCount);
      const position = index % teamCount;
      groups[round % 2 === 0 || strategy === 'RANDOM' ? position : teamCount - 1 - position]!.push(registration.userId);
    });

    const users = await this.prisma.user.findMany({ where: { id: { in: pool.map((p) => p.userId) } }, select: { id: true, displayName: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.displayName] as const));
    const created = [];
    for (const [index, userIds] of groups.entries()) {
      const members = userIds.map((userId, i) => ({ userId, role: roleFor(i, t.teamSize) }));
      created.push(await this.createTeam(t, { name: `Team ${nameOf.get(userIds[0]!) ?? index + 1}`, teamId: null, logoUrl: null, members }));
    }
    await this.prisma.tournamentRegistration.updateMany({ where: { tournamentId, userId: { in: pool.map((p) => p.userId) } }, data: { status: 'ASSIGNED' } });
    await this.audit.record({ actor: actor.audit, action: 'tournament.auto_assign', targetType: 'tournament', targetId: tournamentId, targetLabel: t.name, newValue: { strategy, teams: teamCount, leftover: registrations.length - pool.length }, ip: actor.ip });
    this.tournaments.emitUpdated(tournamentId);
    return { teams: created, leftoverPlayers: registrations.length - pool.length };
  }

  // ─────────────── internals ───────────────

  private async createTeam(t: Tournament, input: { name: string; teamId: string | null; logoUrl: string | null; members: Array<{ userId: string; role: Role }> }) {
    const count = await this.prisma.tournamentTeam.count({ where: { tournamentId: t.id, status: { not: 'WITHDRAWN' } } });
    if (count >= t.maxTeams) throw conflict('TOURNAMENT_FULL', 'The tournament is full');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const team = await tx.tournamentTeam.create({
          data: { tournamentId: t.id, teamId: input.teamId, name: input.name, nameKey: input.name.trim().toLowerCase(), logoUrl: input.logoUrl, status: 'CONFIRMED' },
        });
        await tx.tournamentTeamMember.createMany({ data: input.members.map((m) => ({ tournamentId: t.id, tournamentTeamId: team.id, userId: m.userId, role: m.role })) });
        await this.updateAverageElo(tx, t, team.id);
        return tx.tournamentTeam.findUniqueOrThrow({ where: { id: team.id }, include: { members: true } });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('TEAM_CONFLICT', 'A team with this name exists, or a player is already in the tournament');
      throw error;
    }
  }

  private async updateAverageElo(tx: TransactionClient, t: Tournament, teamId: string): Promise<void> {
    const members = await tx.tournamentTeamMember.findMany({ where: { tournamentTeamId: teamId, role: { not: 'SUBSTITUTE' } }, select: { userId: true } });
    const ranks = await tx.playerRank.findMany({ where: { mode: t.mode, userId: { in: members.map((m) => m.userId) } } });
    const total = members.reduce((sum, m) => sum + (ranks.find((r) => r.userId === m.userId)?.elo ?? 1000), 0);
    await tx.tournamentTeam.update({ where: { id: teamId }, data: { averageElo: members.length ? Math.round(total / members.length) : 1000 } });
  }

  private assertOpen(t: Tournament): void {
    if (t.status !== 'SCHEDULED') throw conflict('REGISTRATION_CLOSED', 'This tournament is not open for registration');
    if (!t.registrationOpen) throw conflict('REGISTRATION_CLOSED', 'Registration is closed');
  }

  private async requireEditable(tournamentId: string): Promise<Tournament> {
    const t = await this.tournaments.require(tournamentId);
    if (!['DRAFT', 'SCHEDULED'].includes(t.status)) throw conflict('TOURNAMENT_STARTED', 'Teams cannot be changed after the tournament started');
    return t;
  }

  private assertRoster(t: Tournament, members: Array<{ userId: string; role: Role }>): void {
    const ids = members.map((m) => m.userId);
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_PLAYER', 'A player is listed twice');
    const starters = members.filter((m) => m.role !== 'SUBSTITUTE');
    const subs = members.length - starters.length;
    if (starters.length > t.teamSize) throw badRequest('TOO_MANY_PLAYERS', `A ${t.mode} team has ${t.teamSize} starting players`);
    if (starters.length < 1) throw badRequest('EMPTY_TEAM', 'A team needs at least one starting player');
    if (members.filter((m) => m.role === 'CAPTAIN').length > 1) throw badRequest('TOO_MANY_CAPTAINS', 'A team has one captain');
    if (subs > 0 && (!t.allowSubstitutes || subs > t.substitutesPerTeam)) throw badRequest('TOO_MANY_SUBSTITUTES', `At most ${t.allowSubstitutes ? t.substitutesPerTeam : 0} substitutes are allowed`);
  }

  /** Every player must exist, be unbanned, fit the Elo window and not already be in the tournament. */
  private async assertEligible(t: Tournament, userIds: string[], options: { skipElo?: boolean; ignoreTeamId?: string } = {}): Promise<void> {
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } });
    if (users.length !== new Set(userIds).size) throw badRequest('UNKNOWN_PLAYER', 'A player does not exist');
    const name = new Map(users.map((u) => [u.id, u.displayName] as const));

    const bans = await this.prisma.ban.findMany({
      where: { userId: { in: userIds }, type: 'PLATFORM', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: this.clock.now() } }] },
      select: { userId: true },
    });
    if (bans.length > 0) throw forbidden(`${name.get(bans[0]!.userId)} is banned from the platform`, 'PLAYER_BANNED');

    if (!options.skipElo && (t.minElo !== null || t.maxElo !== null)) {
      const ranks = await this.prisma.playerRank.findMany({ where: { mode: t.mode, userId: { in: userIds } } });
      for (const id of userIds) {
        const elo = ranks.find((r) => r.userId === id)?.elo ?? 1000;
        if ((t.minElo !== null && elo < t.minElo) || (t.maxElo !== null && elo > t.maxElo)) {
          throw forbidden(`${name.get(id)} (Elo ${elo}) is outside the allowed range ${t.minElo ?? 0}–${t.maxElo ?? '∞'}`, 'ELO_OUT_OF_RANGE');
        }
      }
    }

    const [registered, inTeam] = await Promise.all([
      this.prisma.tournamentRegistration.findFirst({ where: { tournamentId: t.id, userId: { in: userIds }, status: { not: 'ASSIGNED' } } }),
      this.prisma.tournamentTeamMember.findFirst({ where: { tournamentId: t.id, userId: { in: userIds }, ...(options.ignoreTeamId ? { tournamentTeamId: { not: options.ignoreTeamId } } : {}) } }),
    ]);
    if (registered && userIds.length > 1) throw conflict('ALREADY_REGISTERED', `${name.get(registered.userId)} is already registered as a solo player`);
    if (registered && userIds.length === 1) throw conflict('ALREADY_REGISTERED', 'You are already registered');
    if (inTeam) throw conflict('ALREADY_IN_TOURNAMENT', `${name.get(inTeam.userId)} is already in a team of this tournament`);
  }
}

function roleFor(index: number, teamSize: number): Role {
  if (index === 0) return 'CAPTAIN';
  return index < teamSize ? 'MEMBER' : 'SUBSTITUTE';
}
