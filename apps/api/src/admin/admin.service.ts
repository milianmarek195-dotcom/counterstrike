import { Injectable } from '@nestjs/common';
import type { Prisma } from '@celtist/database';
import {
  PROTECTED_ROLE_KEY,
  PERMISSIONS,
  isGrantedPermission,
  resolveRank,
  validateRankTiers,
  type GameMode,
  type RankTier,
} from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { RankTiersService } from '../ranking/rank-tiers.service.js';
import { PermissionResolver } from '../security/permission-resolver.service.js';
import { SessionService } from '../security/session.service.js';
import { effectiveStatus } from '../servers/servers.service.js';

export interface AdminCtx {
  actor: AuditActor;
  actorUserId: string;
  ip?: string | null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly permissions: PermissionResolver,
    private readonly sessions: SessionService,
    private readonly tiers: RankTiersService,
  ) {}

  // ─────────────── dashboard ───────────────

  async dashboard() {
    const now = this.clock.now();
    const [activeSessions, activeMatches, runningTournaments, servers, recentMatches, recentBans, recentActions, upcoming] = await Promise.all([
      this.prisma.session.groupBy({ by: ['userId'], where: { revokedAt: null, lastSeenAt: { gte: new Date(now.getTime() - 5 * 60_000) }, absoluteExpiresAt: { gt: now } } }),
      this.prisma.match.count({ where: { status: { in: ['LOBBY', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'LIVE', 'SERVER_ERROR'] } } }),
      this.prisma.tournament.count({ where: { status: { in: ['RUNNING', 'PAUSED'] } } }),
      this.prisma.server.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.match.findMany({ where: { status: { in: ['FINISHED', 'CANCELLED'] } }, orderBy: { finishedAt: 'desc' }, take: 8, include: { teams: { select: { slot: true, name: true, seriesScore: true } } } }),
      this.prisma.ban.findMany({ orderBy: { createdAt: 'desc' }, take: 6, include: { user: { select: { displayName: true, steamId: true } } } }),
      this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 12 }),
      this.prisma.tournament.count({ where: { status: 'SCHEDULED' } }),
    ]);
    const statusCounts: Record<string, number> = {};
    for (const s of servers) {
      const status = effectiveStatus(s, now);
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    return {
      onlinePlayers: activeSessions.length,
      activeMatches,
      activeTournaments: runningTournaments,
      upcomingTournaments: upcoming,
      servers: {
        total: servers.length,
        byStatus: statusCounts,
        list: servers.map((s) => ({ id: s.id, name: s.name, region: s.region, status: effectiveStatus(s, now), playerCount: s.playerCount, maxPlayers: s.maxPlayers, health: s.health, lastHeartbeatAt: s.lastHeartbeatAt, currentMatchId: s.currentMatchId })),
      },
      recentMatches: recentMatches.map((m) => ({ id: m.id, status: m.status, finishedAt: m.finishedAt, kind: m.kind, teams: Object.fromEntries(m.teams.map((t) => [t.slot, { name: t.name, score: t.seriesScore }])) })),
      recentBans: recentBans.map((b) => ({ id: b.id, type: b.type, reason: b.reason, createdAt: b.createdAt, expiresAt: b.expiresAt, revokedAt: b.revokedAt, player: b.user })),
      recentAdminActions: recentActions.map((a) => ({ id: a.id, actor: a.actorLabel, action: a.action, target: a.targetLabel ?? a.targetId, createdAt: a.createdAt })),
    };
  }

  // ─────────────── players ───────────────

  async searchPlayers(query: { q?: string; page: number; pageSize: number }) {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = q ? { OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { steamId: { contains: q } }] } : {};
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { displayName: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { ranks: true, roles: { include: { role: { select: { key: true, name: true } } } } },
      }),
    ]);
    return {
      total,
      page: query.page,
      pageSize: query.pageSize,
      players: users.map((u) => ({ id: u.id, steamId: u.steamId, displayName: u.displayName, avatarUrl: u.avatarUrl, lastLoginAt: u.lastLoginAt, elo: Object.fromEntries(u.ranks.map((r) => [r.mode, r.elo])), roles: u.roles.map((r) => r.role) })),
    };
  }

  async playerDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { steamProfile: true, ranks: true, roles: { include: { role: { select: { key: true, name: true } } } } },
    });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    const [bans, matches, skin] = await Promise.all([
      this.prisma.ban.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20, include: { issuedBy: { select: { displayName: true } } } }),
      this.prisma.matchPlayer.findMany({ where: { userId, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, take: 10, select: { matchId: true, finishedAt: true, won: true, kills: true, deaths: true, eloDelta: true } }),
      this.prisma.skinPermission.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const tiers = await this.tiers.tiers();
    return {
      id: user.id,
      steamId: user.steamId,
      displayName: user.displayName,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      steam: user.steamProfile,
      ranks: user.ranks.map((r) => ({ mode: r.mode, elo: r.elo, peakElo: r.peakElo, matches: r.matches, wins: r.wins, losses: r.losses, rank: resolveRank(r.elo, tiers).name })),
      roles: user.roles.map((r) => r.role),
      bans: bans.map((b) => ({ id: b.id, type: b.type, reason: b.reason, createdAt: b.createdAt, expiresAt: b.expiresAt, revokedAt: b.revokedAt, issuedBy: b.issuedBy?.displayName ?? null, active: this.isActive(b) })),
      recentMatches: matches,
      latestSkinGrant: skin,
    };
  }

  async setElo(userId: string, mode: GameMode, elo: number, reason: string, ctx: AdminCtx) {
    const rank = await this.prisma.playerRank.findUnique({ where: { userId_mode: { userId, mode } }, include: { user: { select: { displayName: true } } } });
    if (!rank) throw notFound('PLAYER_NOT_FOUND', 'Player has no rating in this mode');
    const updated = await this.prisma.playerRank.update({ where: { userId_mode: { userId, mode } }, data: { elo, peakElo: Math.max(rank.peakElo, elo) } });
    await this.audit.record({ actor: ctx.actor, action: 'player.elo.set', targetType: 'user', targetId: userId, targetLabel: rank.user.displayName, reason, oldValue: { mode, elo: rank.elo }, newValue: { mode, elo: updated.elo }, ip: ctx.ip });
    return { mode, elo: updated.elo };
  }

  /** Puts the player at the lower bound of a rank tier (the rank itself is derived from Elo). */
  async setRank(userId: string, mode: GameMode, tierKey: string, reason: string, ctx: AdminCtx) {
    const tier = (await this.tiers.tiers()).find((t) => t.key === tierKey);
    if (!tier) throw notFound('RANK_NOT_FOUND', 'Rank tier does not exist');
    const result = await this.setElo(userId, mode, tier.minElo, reason, ctx);
    return { ...result, rank: tier.name };
  }

  // ─────────────── bans ───────────────

  async listBans(page: number, pageSize: number, activeOnly: boolean) {
    const now = this.clock.now();
    const where: Prisma.BanWhereInput = activeOnly ? { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } : {};
    const [total, rows] = await Promise.all([
      this.prisma.ban.count({ where }),
      this.prisma.ban.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { displayName: true, steamId: true } }, issuedBy: { select: { displayName: true } } } }),
    ]);
    return { total, page, pageSize, bans: rows.map((b) => ({ id: b.id, type: b.type, reason: b.reason, player: b.user, issuedBy: b.issuedBy?.displayName ?? null, createdAt: b.createdAt, expiresAt: b.expiresAt, revokedAt: b.revokedAt, active: this.isActive(b) })) };
  }

  /** Platform ban: the player cannot register, join servers or queue; open sessions are ended. */
  async ban(input: { userId: string; reason: string; durationHours?: number }, ctx: AdminCtx) {
    const user = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, displayName: true } });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    if (user.id === ctx.actorUserId) throw badRequest('CANNOT_BAN_SELF', 'You cannot ban yourself');
    const target = await this.permissions.forUser(user.id);
    if (target.has('role.manage') || target.has('admin.access')) throw forbidden('Administrators cannot be banned; remove their roles first', 'CANNOT_BAN_ADMIN');

    const expiresAt = input.durationHours ? new Date(this.clock.nowMs() + input.durationHours * 3600_000) : null;
    const ban = await this.prisma.ban.create({ data: { userId: user.id, type: 'PLATFORM', reason: input.reason, issuedById: ctx.actorUserId, expiresAt } });
    await this.sessions.revokeAllForUser(user.id);
    await this.audit.record({ actor: ctx.actor, action: 'player.ban', targetType: 'user', targetId: user.id, targetLabel: user.displayName, reason: input.reason, newValue: { expiresAt: expiresAt?.toISOString() ?? 'permanent' }, ip: ctx.ip });
    return { id: ban.id, expiresAt };
  }

  async unban(userId: string, reason: string, ctx: AdminCtx) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    const lifted = await this.prisma.ban.updateMany({ where: { userId, type: 'PLATFORM', revokedAt: null }, data: { revokedAt: this.clock.now(), revokedById: ctx.actorUserId, revokeReason: reason } });
    if (lifted.count === 0) throw conflict('NOT_BANNED', 'The player has no active ban');
    await this.audit.record({ actor: ctx.actor, action: 'player.unban', targetType: 'user', targetId: userId, targetLabel: user.displayName, reason, oldValue: { bans: lifted.count }, ip: ctx.ip });
  }

  /** Pardon: lifts every match-level penalty (team-damage removals, match bans) of the player. */
  async pardon(userId: string, reason: string, ctx: AdminCtx) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    const lifted = await this.prisma.ban.updateMany({ where: { userId, type: 'MATCH', revokedAt: null }, data: { revokedAt: this.clock.now(), revokedById: ctx.actorUserId, revokeReason: reason } });
    await this.audit.record({ actor: ctx.actor, action: 'player.pardon', targetType: 'user', targetId: userId, targetLabel: user.displayName, reason, oldValue: { matchBans: lifted.count }, ip: ctx.ip });
    return { lifted: lifted.count };
  }

  // ─────────────── roles ───────────────

  async listRoles() {
    const roles = await this.prisma.role.findMany({ orderBy: { position: 'asc' }, include: { permissions: true, _count: { select: { users: true } } } });
    return { available: [...PERMISSIONS, '*'], roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem, members: r._count.users, permissions: r.permissions.map((p) => p.permission).sort() })) };
  }

  async createRole(input: { key: string; name: string; description?: string; permissions: string[] }, ctx: AdminCtx) {
    this.assertPermissions(input.permissions);
    if (await this.prisma.role.findUnique({ where: { key: input.key } })) throw conflict('ROLE_KEY_TAKEN', 'A role with this key exists');
    const role = await this.prisma.role.create({ data: { key: input.key, name: input.name, description: input.description ?? null, position: 100, permissions: { create: [...new Set(input.permissions)].map((permission) => ({ permission })) } } });
    await this.audit.record({ actor: ctx.actor, action: 'role.create', targetType: 'role', targetId: role.id, targetLabel: role.name, newValue: input, ip: ctx.ip });
    return role;
  }

  async updateRole(roleId: string, input: { name?: string; description?: string; permissions?: string[] }, ctx: AdminCtx) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role does not exist');
    if (input.permissions) {
      this.assertPermissions(input.permissions);
      if (role.key === PROTECTED_ROLE_KEY && !input.permissions.includes('*')) throw forbidden('The Owner role always keeps full access', 'OWNER_ROLE_PROTECTED');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.role.update({ where: { id: roleId }, data: { ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}) } });
      if (input.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId } });
        await tx.rolePermission.createMany({ data: [...new Set(input.permissions)].map((permission) => ({ roleId, permission })) });
      }
    });
    await this.permissions.invalidateAll();
    await this.audit.record({ actor: ctx.actor, action: 'role.update', targetType: 'role', targetId: roleId, targetLabel: role.name, oldValue: { name: role.name, permissions: role.permissions.map((p) => p.permission).sort() }, newValue: input, ip: ctx.ip });
  }

  async deleteRole(roleId: string, ctx: AdminCtx) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role does not exist');
    if (role.isSystem) throw forbidden('System roles cannot be deleted', 'SYSTEM_ROLE_PROTECTED');
    if (role._count.users > 0) throw conflict('ROLE_IN_USE', 'Remove the role from its members first');
    await this.prisma.role.delete({ where: { id: roleId } });
    await this.audit.record({ actor: ctx.actor, action: 'role.delete', targetType: 'role', targetId: roleId, targetLabel: role.name, ip: ctx.ip });
  }

  /** Replaces a user's roles. The last Owner can never be removed, so the platform cannot lock itself out. */
  async setUserRoles(userId: string, roleKeys: string[], reason: string, ctx: AdminCtx) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
    if (!user) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    const roles = await this.prisma.role.findMany({ where: { key: { in: roleKeys } } });
    if (roles.length !== new Set(roleKeys).size) throw badRequest('UNKNOWN_ROLE', 'A role does not exist');

    const hadOwner = user.roles.some((r) => r.role.key === PROTECTED_ROLE_KEY);
    const willHaveOwner = roleKeys.includes(PROTECTED_ROLE_KEY);
    if (hadOwner && !willHaveOwner) {
      const owners = await this.prisma.userRole.count({ where: { role: { key: PROTECTED_ROLE_KEY } } });
      if (owners <= 1) throw forbidden('The last Owner cannot be removed', 'LAST_OWNER');
    }
    if (!hadOwner && willHaveOwner && !(await this.permissions.forUser(ctx.actorUserId)).has('role.manage')) throw forbidden('Only role managers can appoint owners', 'FORBIDDEN');

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id, grantedById: ctx.actorUserId })) });
    });
    await this.permissions.invalidateUser(userId);
    await this.audit.record({ actor: ctx.actor, action: 'player.roles.set', targetType: 'user', targetId: userId, targetLabel: user.displayName, reason, oldValue: user.roles.map((r) => r.role.key).sort(), newValue: [...roleKeys].sort(), ip: ctx.ip });
  }

  // ─────────────── rank tiers ───────────────

  async setRankTiers(tiers: RankTier[], ctx: AdminCtx) {
    const withPositions = [...tiers].sort((a, b) => a.minElo - b.minElo).map((t, i) => ({ ...t, position: i + 1 }));
    const errors = validateRankTiers(withPositions);
    if (errors.length > 0) throw badRequest('INVALID_RANK_TIERS', 'The rank tiers are not valid', errors);
    const before = await this.tiers.tiers();
    await this.prisma.$transaction(async (tx) => {
      await tx.rankTier.deleteMany();
      await tx.rankTier.createMany({ data: withPositions.map((t) => ({ key: t.key, name: t.name, minElo: t.minElo, color: t.color, position: t.position })) });
    });
    await this.tiers.invalidate();
    await this.audit.record({ actor: ctx.actor, action: 'settings.rank_tiers', targetType: 'settings', targetId: 'rank_tiers', oldValue: before.map((t) => ({ key: t.key, minElo: t.minElo })), newValue: withPositions.map((t) => ({ key: t.key, minElo: t.minElo })), ip: ctx.ip });
    return { tiers: withPositions };
  }

  // ─────────────── audit ───────────────

  async auditLog(query: { actorId?: string; action?: string; targetType?: string; targetId?: string; from?: string; to?: string; page: number; pageSize: number }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, entries: rows };
  }

  private assertPermissions(list: string[]): void {
    const invalid = list.filter((p) => !isGrantedPermission(p));
    if (invalid.length > 0) throw badRequest('UNKNOWN_PERMISSION', `Unknown permissions: ${invalid.join(', ')}`);
  }

  private isActive(b: { revokedAt: Date | null; expiresAt: Date | null }): boolean {
    return b.revokedAt === null && (b.expiresAt === null || b.expiresAt.getTime() > this.clock.nowMs());
  }
}
