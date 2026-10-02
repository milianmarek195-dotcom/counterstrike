import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isGameModeEnabled, type GameMode } from '@celtist/shared';
import { isUniqueViolation } from '@celtist/database';
import { Clock } from '../common/clock.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_LOGO_BYTES = 512 * 1024;
const MAX_MEMBERS = 12;

/** Image type by magic bytes: the client-supplied content type and file name are never trusted. */
export function sniffImage(buf: Buffer): { ext: 'png' | 'jpg' | 'webp'; mime: string } | null {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly notifications: NotificationsService,
  ) {}

  async create(userId: string, input: { name: string; tag?: string; mode: GameMode }) {
    if (!isGameModeEnabled(input.mode)) throw badRequest('MODE_COMING_SOON', 'This game mode is coming soon');
    const nameKey = input.name.trim().toLowerCase();
    try {
      const team = await this.prisma.$transaction(async (tx) => {
        const created = await tx.team.create({ data: { name: input.name, nameKey, tag: input.tag ?? null, mode: input.mode, captainId: userId } });
        await tx.teamMember.create({ data: { teamId: created.id, userId, mode: input.mode, role: 'CAPTAIN' } });
        return created;
      });
      return { id: team.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const inTeam = await this.prisma.teamMember.findUnique({ where: { userId_mode: { userId, mode: input.mode } } });
        throw inTeam ? conflict('ALREADY_IN_TEAM', 'Leave your current team first') : conflict('TEAM_NAME_TAKEN', 'A team with this name exists');
      }
      throw error;
    }
  }

  async list(query: { q?: string; mode?: GameMode; page: number; pageSize: number }) {
    const where = { disbandedAt: null, ...(query.mode ? { mode: query.mode } : {}), ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.team.count({ where }),
      this.prisma.team.findMany({ where, orderBy: { name: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize, include: { _count: { select: { members: true } } } }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, teams: rows.map((t) => ({ id: t.id, name: t.name, tag: t.tag, mode: t.mode, hasLogo: !!t.logoUrl, members: t._count.members })) };
  }

  async get(teamId: string, viewerId?: string) {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, disbandedAt: null },
      include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: { select: { id: true, displayName: true, avatarUrl: true, ranks: { select: { mode: true, elo: true } } } } } } },
    });
    if (!team) throw notFound('TEAM_NOT_FOUND', 'Team does not exist');
    return {
      id: team.id,
      name: team.name,
      tag: team.tag,
      mode: team.mode,
      hasLogo: !!team.logoUrl,
      captainId: team.captainId,
      createdAt: team.createdAt,
      members: team.members.map((m) => ({ userId: m.userId, displayName: m.user.displayName, avatarUrl: m.user.avatarUrl, role: m.role, elo: m.user.ranks.find((r) => r.mode === team.mode)?.elo ?? null })),
      viewer: viewerId ? { isCaptain: viewerId === team.captainId, isMember: team.members.some((m) => m.userId === viewerId) } : null,
    };
  }

  async mine(userId: string) {
    const [memberships, invites] = await Promise.all([
      this.prisma.teamMember.findMany({ where: { userId, team: { disbandedAt: null } }, select: { teamId: true } }),
      this.prisma.teamInvite.findMany({ where: { inviteeId: userId, status: 'PENDING', expiresAt: { gt: this.clock.now() } }, include: { team: { select: { id: true, name: true } }, invitedBy: { select: { displayName: true } } } }),
    ]);
    return { teamIds: memberships.map((m) => m.teamId), invites: invites.map((i) => ({ id: i.id, team: i.team, invitedBy: i.invitedBy.displayName, expiresAt: i.expiresAt })) };
  }

  async update(teamId: string, userId: string, patch: { name?: string; tag?: string | null }) {
    await this.requireCaptain(teamId, userId);
    try {
      await this.prisma.team.update({ where: { id: teamId }, data: { ...(patch.name ? { name: patch.name, nameKey: patch.name.toLowerCase() } : {}), ...(patch.tag !== undefined ? { tag: patch.tag } : {}) } });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('TEAM_NAME_TAKEN', 'A team with this name exists');
      throw error;
    }
  }

  async invite(teamId: string, captainId: string, target: { userId?: string; steamId?: string }) {
    const team = await this.requireCaptain(teamId, captainId);
    const invitee = await this.prisma.user.findFirst({ where: target.userId ? { id: target.userId } : { steamId: target.steamId } });
    if (!invitee) throw notFound('PLAYER_NOT_FOUND', 'Player does not exist');
    if (invitee.id === captainId) throw badRequest('CANNOT_INVITE_SELF', 'You are already in the team');
    if (await this.prisma.teamMember.findUnique({ where: { userId_mode: { userId: invitee.id, mode: team.mode } } })) throw conflict('ALREADY_IN_TEAM', 'The player is already in a team');
    if ((await this.prisma.teamMember.count({ where: { teamId } })) >= MAX_MEMBERS) throw conflict('TEAM_FULL', 'The team is full');
    const now = this.clock.now();
    if (await this.prisma.teamInvite.findFirst({ where: { teamId, inviteeId: invitee.id, status: 'PENDING', expiresAt: { gt: now } } })) throw conflict('ALREADY_INVITED', 'The player was already invited');
    await this.prisma.teamInvite.create({ data: { teamId, inviteeId: invitee.id, invitedById: captainId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) } });
    await this.notifications.notify({ userId: invitee.id, type: 'team.invite', title: `Invitation to ${team.name}`, data: { teamId } });
  }

  async respond(inviteId: string, userId: string, accept: boolean) {
    const invite = await this.prisma.teamInvite.findFirst({ where: { id: inviteId, inviteeId: userId, status: 'PENDING' }, include: { team: true } });
    if (!invite || invite.team.disbandedAt) throw notFound('INVITE_NOT_FOUND', 'Invitation not found');
    if (invite.expiresAt <= this.clock.now()) {
      await this.prisma.teamInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED', respondedAt: this.clock.now() } });
      throw notFound('INVITE_NOT_FOUND', 'Invitation expired');
    }
    if (!accept) {
      await this.prisma.teamInvite.update({ where: { id: invite.id }, data: { status: 'DECLINED', respondedAt: this.clock.now() } });
      return;
    }
    if ((await this.prisma.teamMember.count({ where: { teamId: invite.teamId } })) >= MAX_MEMBERS) throw conflict('TEAM_FULL', 'The team is full');
    try {
      await this.prisma.$transaction([
        this.prisma.teamMember.create({ data: { teamId: invite.teamId, userId, mode: invite.team.mode } }),
        this.prisma.teamInvite.update({ where: { id: invite.id }, data: { status: 'ACCEPTED', respondedAt: this.clock.now() } }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('ALREADY_IN_TEAM', 'Leave your current team first');
      throw error;
    }
  }

  async kick(teamId: string, captainId: string, userId: string) {
    await this.requireCaptain(teamId, captainId);
    if (userId === captainId) throw badRequest('CANNOT_KICK_SELF', 'Use leave or transfer the captaincy');
    const { count } = await this.prisma.teamMember.deleteMany({ where: { teamId, userId } });
    if (count === 0) throw notFound('MEMBER_NOT_FOUND', 'Player is not in the team');
  }

  /** A captain must hand over the team (or disband) before leaving, so a team never ends up without one. */
  async leave(teamId: string, userId: string) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, disbandedAt: null } });
    if (!team) throw notFound('TEAM_NOT_FOUND', 'Team does not exist');
    if (team.captainId === userId) throw conflict('CAPTAIN_CANNOT_LEAVE', 'Transfer the captaincy or disband the team');
    const { count } = await this.prisma.teamMember.deleteMany({ where: { teamId, userId } });
    if (count === 0) throw notFound('MEMBER_NOT_FOUND', 'You are not in this team');
  }

  async transferCaptain(teamId: string, captainId: string, newCaptainId: string) {
    await this.requireCaptain(teamId, captainId);
    if (newCaptainId === captainId) throw badRequest('ALREADY_CAPTAIN', 'You are already the captain');
    if (!(await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId, userId: newCaptainId } } }))) throw notFound('MEMBER_NOT_FOUND', 'Player is not in the team');
    await this.prisma.$transaction([
      this.prisma.team.update({ where: { id: teamId }, data: { captainId: newCaptainId } }),
      this.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId: captainId } }, data: { role: 'MEMBER' } }),
      this.prisma.teamMember.update({ where: { teamId_userId: { teamId, userId: newCaptainId } }, data: { role: 'CAPTAIN' } }),
    ]);
  }

  /** Disbanding keeps the row (history, tournament entries) but frees every member and the name. */
  async disband(teamId: string, userId: string) {
    const team = await this.requireCaptain(teamId, userId);
    const active = await this.prisma.tournamentTeam.count({ where: { teamId, tournament: { status: { in: ['SCHEDULED', 'RUNNING', 'PAUSED'] } } } });
    if (active > 0) throw conflict('TEAM_IN_TOURNAMENT', 'The team is registered in an active tournament');
    await this.prisma.$transaction([
      this.prisma.teamMember.deleteMany({ where: { teamId } }),
      this.prisma.teamInvite.updateMany({ where: { teamId, status: 'PENDING' }, data: { status: 'REVOKED', respondedAt: this.clock.now() } }),
      this.prisma.team.update({ where: { id: teamId }, data: { disbandedAt: this.clock.now(), nameKey: `${team.nameKey}#disbanded:${team.id}`.slice(0, 40) } }),
    ]);
    for (const ext of ['png', 'jpg', 'webp']) await rm(this.logoPath(teamId, ext), { force: true });
  }

  async setLogo(teamId: string, userId: string, data: Buffer) {
    await this.requireCaptain(teamId, userId);
    if (data.length === 0 || data.length > MAX_LOGO_BYTES) throw badRequest('INVALID_LOGO', 'Logo must be between 1 byte and 512 KB');
    const type = sniffImage(data);
    if (!type) throw badRequest('INVALID_LOGO', 'Logo must be a PNG, JPEG or WebP image');
    await mkdir(this.logoDir(), { recursive: true });
    for (const ext of ['png', 'jpg', 'webp']) await rm(this.logoPath(teamId, ext), { force: true });
    await writeFile(this.logoPath(teamId, type.ext), data);
    await this.prisma.team.update({ where: { id: teamId }, data: { logoUrl: `/v1/teams/${teamId}/logo?v=${this.clock.nowMs()}` } });
  }

  async logo(teamId: string): Promise<{ data: Buffer; mime: string }> {
    for (const [ext, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
      try {
        return { data: await readFile(this.logoPath(teamId, ext)), mime };
      } catch {
        /* try next extension */
      }
    }
    throw notFound('LOGO_NOT_FOUND', 'The team has no logo');
  }

  private async requireCaptain(teamId: string, userId: string) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, disbandedAt: null } });
    if (!team) throw notFound('TEAM_NOT_FOUND', 'Team does not exist');
    if (team.captainId !== userId) throw forbidden('Only the team captain can do this', 'NOT_CAPTAIN');
    return team;
  }

  private logoDir(): string {
    return join(this.config.env.UPLOAD_DIR, 'team-logos');
  }

  private logoPath(teamId: string, ext: string): string {
    // teamId is a validated UUID at the controller, so it cannot contain path separators.
    return join(this.logoDir(), `${teamId}.${ext}`);
  }
}
