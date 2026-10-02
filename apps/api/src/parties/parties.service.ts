import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation, type Party } from '@celtist/database';
import type { CreatePartyMatchInput } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload, type PartyEventPayload } from '../common/domain-events.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { MapsService } from '../maps/maps.service.js';
import { MatchFactory } from '../matches/core/match-factory.service.js';
import { MatchLifecycleService } from '../matches/match-lifecycle.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export const PARTY_MAX_MEMBERS = 16;
const INVITE_TTL_MS = 15 * 60_000;
const OPEN_MATCH = ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'LIVE', 'SERVER_ERROR'] as const;

@Injectable()
export class PartiesService {
  private readonly logger = new Logger(PartiesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly maps: MapsService,
    private readonly factory: MatchFactory,
    private readonly lifecycle: MatchLifecycleService,
    private readonly notifications: NotificationsService,
    private readonly events: EventEmitter2,
  ) {}

  // ─────────────── reading ───────────────

  /** The caller's party (with members, pending invites and the active match), or null. */
  async mine(userId: string) {
    const membership = await this.prisma.partyMember.findUnique({ where: { userId } });
    if (!membership) return { party: null, invites: await this.myInvites(userId) };
    const party = await this.prisma.party.findUniqueOrThrow({
      where: { id: membership.partyId },
      include: {
        members: { include: { user: { select: { id: true, steamId: true, displayName: true, avatarUrl: true } } }, orderBy: { joinedAt: 'asc' } },
        invites: { where: { status: 'PENDING', expiresAt: { gt: this.clock.now() } }, include: { invitee: { select: { id: true, steamId: true, displayName: true } } } },
      },
    });
    const match = await this.prisma.match.findFirst({
      where: { controllerId: party.leaderId, kind: 'CUSTOM', status: { in: [...OPEN_MATCH] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    return {
      party: {
        id: party.id,
        leaderId: party.leaderId,
        status: party.status,
        isLeader: party.leaderId === userId,
        maxMembers: PARTY_MAX_MEMBERS,
        members: party.members.map((m) => ({ ...m.user, isLeader: m.userId === party.leaderId, joinedAt: m.joinedAt })),
        pendingInvites: party.invites.map((i) => ({ id: i.id, user: i.invitee, expiresAt: i.expiresAt })),
        activeMatch: match,
      },
      invites: [],
    };
  }

  async myInvites(userId: string) {
    const invites = await this.prisma.partyInvite.findMany({
      where: { inviteeId: userId, status: 'PENDING', expiresAt: { gt: this.clock.now() } },
      include: { invitedBy: { select: { displayName: true, steamId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((i) => ({ id: i.id, partyId: i.partyId, from: i.invitedBy, expiresAt: i.expiresAt }));
  }

  // ─────────────── lifecycle of a party ───────────────

  async create(userId: string): Promise<Party> {
    if (await this.prisma.partyMember.findUnique({ where: { userId } })) throw conflict('ALREADY_IN_PARTY', 'Leave your current party first');
    try {
      const party = await this.prisma.party.create({ data: { leaderId: userId, members: { create: { userId } } } });
      this.emit(party.id, [userId]);
      return party;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('ALREADY_IN_PARTY', 'You already lead or belong to a party');
      throw error;
    }
  }

  async invite(leaderId: string, target: { userId?: string; steamId?: string }): Promise<void> {
    const party = await this.requireLeaderParty(leaderId);
    const user = await this.prisma.user.findFirst({ where: target.userId ? { id: target.userId } : { steamId: target.steamId } });
    if (!user) throw notFound('USER_NOT_FOUND', 'That player has not signed in to the platform yet');
    if (user.id === leaderId) throw badRequest('CANNOT_INVITE_SELF', 'You are already in the party');
    if (await this.prisma.partyMember.findUnique({ where: { userId: user.id } })) throw conflict('PLAYER_IN_PARTY', 'That player is already in a party');
    const count = await this.prisma.partyMember.count({ where: { partyId: party.id } });
    if (count >= PARTY_MAX_MEMBERS) throw conflict('PARTY_FULL', `A party has at most ${PARTY_MAX_MEMBERS} members`);

    const open = await this.prisma.partyInvite.findFirst({ where: { partyId: party.id, inviteeId: user.id, status: 'PENDING', expiresAt: { gt: this.clock.now() } } });
    if (open) throw conflict('ALREADY_INVITED', 'That player already has an open invitation');
    const leader = await this.prisma.user.findUniqueOrThrow({ where: { id: leaderId }, select: { displayName: true } });
    try {
      await this.prisma.partyInvite.create({ data: { partyId: party.id, inviteeId: user.id, invitedById: leaderId, expiresAt: new Date(this.clock.nowMs() + INVITE_TTL_MS) } });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('ALREADY_INVITED', 'That player already has an open invitation');
      throw error;
    }
    await this.notifications.notify({ userId: user.id, type: 'party.invite', title: `${leader.displayName} invited you to a party`, data: { partyId: party.id } });
    this.emit(party.id, [leaderId, user.id]);
  }

  async acceptInvite(userId: string, inviteId: string): Promise<void> {
    const invite = await this.prisma.partyInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.inviteeId !== userId || invite.status !== 'PENDING') throw notFound('INVITE_NOT_FOUND', 'Invitation does not exist');
    if (invite.expiresAt.getTime() <= this.clock.nowMs()) {
      await this.prisma.partyInvite.update({ where: { id: inviteId }, data: { status: 'EXPIRED' } });
      throw conflict('INVITE_EXPIRED', 'The invitation has expired');
    }
    if (await this.prisma.partyMember.findUnique({ where: { userId } })) throw conflict('ALREADY_IN_PARTY', 'Leave your current party first');
    const count = await this.prisma.partyMember.count({ where: { partyId: invite.partyId } });
    if (count >= PARTY_MAX_MEMBERS) throw conflict('PARTY_FULL', 'The party is full');

    await this.prisma.$transaction([
      this.prisma.partyMember.create({ data: { partyId: invite.partyId, userId } }),
      this.prisma.partyInvite.update({ where: { id: inviteId }, data: { status: 'ACCEPTED' } }),
    ]);
    await this.addToOpenMatch(invite.partyId, userId);
    await this.emitFor(invite.partyId);
  }

  async declineInvite(userId: string, inviteId: string): Promise<void> {
    const invite = await this.prisma.partyInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.inviteeId !== userId || invite.status !== 'PENDING') throw notFound('INVITE_NOT_FOUND', 'Invitation does not exist');
    await this.prisma.partyInvite.update({ where: { id: inviteId }, data: { status: 'DECLINED' } });
    await this.emitFor(invite.partyId);
  }

  /** A member leaves. If the leader leaves, leadership passes to the longest-standing member; the last one disbands the party. */
  async leave(userId: string): Promise<void> {
    const membership = await this.prisma.partyMember.findUnique({ where: { userId }, include: { party: true } });
    if (!membership) throw notFound('NOT_IN_PARTY', 'You are not in a party');
    const party = membership.party;
    await this.prisma.partyMember.delete({ where: { userId } });
    await this.removeFromOpenMatch(party, userId);

    if (party.leaderId !== userId) return this.emitFor(party.id);
    const next = await this.prisma.partyMember.findFirst({ where: { partyId: party.id }, orderBy: { joinedAt: 'asc' } });
    if (!next) {
      await this.prisma.party.delete({ where: { id: party.id } });
      return this.emit(party.id, [userId]);
    }
    await this.setLeader(party, next.userId);
    await this.emitFor(party.id);
  }

  async kick(leaderId: string, userId: string): Promise<void> {
    const party = await this.requireLeaderParty(leaderId);
    if (userId === leaderId) throw badRequest('CANNOT_KICK_SELF', 'Use leave or disband instead');
    const member = await this.prisma.partyMember.findFirst({ where: { partyId: party.id, userId } });
    if (!member) throw notFound('NOT_IN_PARTY', 'That player is not in your party');
    await this.prisma.partyMember.delete({ where: { id: member.id } });
    await this.removeFromOpenMatch(party, userId);
    await this.notifications.notify({ userId, type: 'party.kicked', title: 'You were removed from the party' });
    this.emit(party.id, [leaderId, userId]);
  }

  async transferLeadership(leaderId: string, userId: string): Promise<void> {
    const party = await this.requireLeaderParty(leaderId);
    if (!(await this.prisma.partyMember.findFirst({ where: { partyId: party.id, userId } }))) throw notFound('NOT_IN_PARTY', 'That player is not in your party');
    await this.setLeader(party, userId);
    await this.emitFor(party.id);
  }

  async disband(leaderId: string): Promise<void> {
    const party = await this.requireLeaderParty(leaderId);
    const members = await this.prisma.partyMember.findMany({ where: { partyId: party.id }, select: { userId: true } });
    await this.prisma.party.delete({ where: { id: party.id } });
    this.emit(party.id, members.map((m) => m.userId));
  }

  // ─────────────── party → match ───────────────

  /**
   * The leader opens a match for the party: two empty teams of any size, every party member waiting unassigned in the
   * lobby. The leader steers it (teams, map, server, start) together with the admins. Party matches are unrated.
   */
  async createMatch(leaderId: string, input: CreatePartyMatchInput): Promise<{ matchId: string }> {
    const party = await this.requireLeaderParty(leaderId);
    const open = await this.prisma.match.findFirst({ where: { controllerId: leaderId, kind: 'CUSTOM', status: { in: [...OPEN_MATCH] } } });
    if (open) throw conflict('MATCH_ALREADY_OPEN', 'Finish or end your current match first', { matchId: open.id });

    const pool = input.mapPoolId ? await this.maps.poolOrThrow(input.mapPoolId) : await this.maps.defaultPoolFor('FIVE_V_FIVE');
    if (pool.maps.length < input.bestOf) throw badRequest('MAP_POOL_TOO_SMALL', `The map pool has too few maps for a best-of-${input.bestOf}`);
    const members = await this.prisma.partyMember.findMany({ where: { partyId: party.id }, select: { userId: true } });

    const match = await this.prisma.$transaction(async (tx) => {
      const created = await this.factory.create(tx, {
        kind: 'CUSTOM',
        mode: 'FIVE_V_FIVE',
        bestOf: input.bestOf,
        mapPoolId: pool.id,
        status: 'SCHEDULED',
        createdById: leaderId,
        controllerId: leaderId,
        teams: [
          { slot: 'A', name: input.teamAName, maxPlayers: input.teamAMax, players: [] },
          { slot: 'B', name: input.teamBName, maxPlayers: input.teamBMax, players: [] },
        ],
        unassignedUserIds: members.map((m) => m.userId),
      });
      await tx.party.update({ where: { id: party.id }, data: { status: 'IN_MATCH' } });
      return created;
    });

    // Reserve a server right away if one is free; otherwise the match waits and the leader can pick one later.
    await this.lifecycle.markWaiting(match.id);
    this.events.emit(DomainEvent.MatchUpdated, { matchId: match.id } satisfies MatchEventPayload);
    await this.emitFor(party.id);
    return { matchId: match.id };
  }

  @OnEvent(DomainEvent.MatchFinished)
  @OnEvent(DomainEvent.MatchCancelled)
  async onMatchClosed(payload: MatchEventPayload): Promise<void> {
    const match = await this.prisma.match.findUnique({ where: { id: payload.matchId }, select: { controllerId: true, kind: true } });
    if (!match?.controllerId || match.kind !== 'CUSTOM') return;
    const party = await this.prisma.party.findUnique({ where: { leaderId: match.controllerId } });
    if (party) {
      await this.prisma.party.update({ where: { id: party.id }, data: { status: 'OPEN' } });
      await this.emitFor(party.id);
    }
  }

  // ─────────────── helpers ───────────────

  private async requireLeaderParty(userId: string): Promise<Party> {
    const party = await this.prisma.party.findUnique({ where: { leaderId: userId } });
    if (!party) {
      if (await this.prisma.partyMember.findUnique({ where: { userId } })) throw forbidden('Only the party leader can do this', 'NOT_PARTY_LEADER');
      throw notFound('NOT_IN_PARTY', 'You are not in a party');
    }
    return party;
  }

  private async setLeader(party: Party, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.party.update({ where: { id: party.id }, data: { leaderId: userId } });
      // The match the old leader steered passes to the new leader as well.
      await tx.match.updateMany({ where: { controllerId: party.leaderId, kind: 'CUSTOM', status: { in: [...OPEN_MATCH] } }, data: { controllerId: userId } });
    });
  }

  /** New party members show up in the open match lobby as unassigned players. */
  private async addToOpenMatch(partyId: string, userId: string): Promise<void> {
    const party = await this.prisma.party.findUnique({ where: { id: partyId } });
    if (!party) return;
    const match = await this.prisma.match.findFirst({ where: { controllerId: party.leaderId, kind: 'CUSTOM', status: { in: ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'] } } });
    if (!match) return;
    await this.prisma.$transaction((tx) => this.factory.addUnassigned(tx, match.id, match.mode, [userId]));
    this.events.emit(DomainEvent.MatchUpdated, { matchId: match.id } satisfies MatchEventPayload);
  }

  /** Someone who left the party leaves the match lobby too, as long as the match has not started. */
  private async removeFromOpenMatch(party: Party, userId: string): Promise<void> {
    const match = await this.prisma.match.findFirst({ where: { controllerId: party.leaderId, kind: 'CUSTOM', status: { in: ['SCHEDULED', 'WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'] } } });
    if (!match) return;
    await this.prisma.matchPlayer.deleteMany({ where: { matchId: match.id, userId } });
    this.events.emit(DomainEvent.MatchUpdated, { matchId: match.id } satisfies MatchEventPayload);
  }

  private async emitFor(partyId: string): Promise<void> {
    const members = await this.prisma.partyMember.findMany({ where: { partyId }, select: { userId: true } });
    this.emit(partyId, members.map((m) => m.userId));
  }

  private emit(partyId: string, userIds: string[]): void {
    this.events.emit(DomainEvent.PartyUpdated, { partyId, userIds } satisfies PartyEventPayload);
  }
}
