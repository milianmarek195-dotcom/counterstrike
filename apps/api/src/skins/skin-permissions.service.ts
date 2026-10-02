import { Injectable, Logger } from '@nestjs/common';
import {
  NO_SKIN_PERMISSION,
  effectiveSkinPermission,
  maxGrantableSkinLevel,
  resolveGrantExpiry,
  type EffectiveSkinPermission,
  type GrantSkinPermissionInput,
  type Permission,
} from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { MatchCommandService } from '../matches/match-commands.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface GrantActor {
  audit: AuditActor;
  /** Null for the system (e.g. scripted grants); otherwise the admin or in-game actor. */
  userId: string | null;
  permissions: ReadonlySet<Permission>;
  ip?: string | null;
  /** "web" or "ingame" – recorded in the audit entry. */
  via: 'web' | 'ingame';
}

/**
 * Skin-changer access per player: level 0–3 plus optional sticker crafts / float editing / custom loadouts, optionally
 * time-limited. Grants form a history; the effective permission is computed at read time, so an expired grant stops
 * working at the exact second even if no job has run. Granting needs `skin.assign` plus the matching `skin.level.N`.
 */
@Injectable()
export class SkinPermissionsService {
  private readonly logger = new Logger(SkinPermissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly commands: MatchCommandService,
    private readonly redis: RedisService,
  ) {}

  /** What a player may do right now (platform default when nothing is granted or the grant ended). */
  async effectiveFor(userId: string): Promise<EffectiveSkinPermission> {
    const grants = await this.prisma.skinPermission.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 });
    const defaultLevel = await this.settings.get('skin.defaultLevel');
    return effectiveSkinPermission(grants, this.clock.now(), { ...NO_SKIN_PERMISSION, level: defaultLevel });
  }

  async grant(input: GrantSkinPermissionInput, actor: GrantActor): Promise<EffectiveSkinPermission> {
    this.assertMayGrant(actor, input.level);
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, displayName: true, steamId: true } });
    if (!target) throw notFound('USER_NOT_FOUND', 'Player does not exist');

    const before = await this.effectiveFor(target.id);
    const expiresAt = resolveGrantExpiry(input.duration, input.customMinutes, this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      // Grants are ordered by creation time; keep it strictly increasing so two grants in the same millisecond never tie.
      const latest = await tx.skinPermission.findFirst({ where: { userId: target.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const createdAt = latest && latest.createdAt.getTime() >= this.clock.nowMs() ? new Date(latest.createdAt.getTime() + 1) : this.clock.now();
      await tx.skinPermission.updateMany({ where: { userId: target.id, supersededAt: null, revokedAt: null }, data: { supersededAt: createdAt } });
      await tx.skinPermission.create({
        data: {
          userId: target.id,
          level: input.level,
          stickerCrafts: input.stickerCrafts,
          floatEditing: input.floatEditing,
          customLoadouts: input.customLoadouts,
          grantedById: actor.userId,
          reason: input.reason ?? null,
          expiresAt,
          createdAt,
        },
      });
    });
    const after = await this.effectiveFor(target.id);
    await this.audit.record({
      actor: actor.audit,
      action: 'player.skin_level.set',
      targetType: 'user',
      targetId: target.id,
      targetLabel: target.displayName,
      reason: input.reason ?? null,
      oldValue: summarise(before),
      newValue: { ...summarise(after), duration: input.duration === 'permanent' ? 'permanent' : expiresAt?.toISOString() },
      metadata: { via: actor.via },
      ip: actor.ip,
    });
    await this.notifications.notify({
      userId: target.id,
      type: 'skin.permission',
      title: input.level > 0 ? `Skin access: level ${input.level}${expiresAt ? ' (temporary)' : ''}` : 'Skin access removed',
      data: { level: input.level, expiresAt },
    });
    await this.refreshOnServer(target.id);
    return after;
  }

  async revoke(userId: string, reason: string | undefined, actor: GrantActor): Promise<void> {
    if (!actor.permissions.has('skin.assign')) throw forbidden('You may not change skin access', 'MISSING_PERMISSION');
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true } });
    if (!target) throw notFound('USER_NOT_FOUND', 'Player does not exist');
    const before = await this.effectiveFor(userId);
    if (before.source === 'grant' && maxGrantableSkinLevel(actor.permissions) < before.level) {
      throw forbidden(`Revoking a level ${before.level} grant needs skin.level.${before.level}`, 'MISSING_PERMISSION');
    }
    await this.prisma.skinPermission.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: this.clock.now() } });
    await this.audit.record({ actor: actor.audit, action: 'player.skin_level.revoke', targetType: 'user', targetId: userId, targetLabel: target.displayName, reason: reason ?? null, oldValue: summarise(before), newValue: summarise(await this.effectiveFor(userId)), metadata: { via: actor.via }, ip: actor.ip });
    await this.refreshOnServer(userId);
  }

  /** Active grants, newest first, for the admin overview. */
  async listActive() {
    const now = this.clock.now();
    const rows = await this.prisma.skinPermission.findMany({
      where: { revokedAt: null, supersededAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      include: { user: { select: { id: true, steamId: true, displayName: true } }, grantedBy: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((r) => ({ id: r.id, user: r.user, level: r.level, stickerCrafts: r.stickerCrafts, floatEditing: r.floatEditing, customLoadouts: r.customLoadouts, expiresAt: r.expiresAt, grantedBy: r.grantedBy?.displayName ?? 'system', createdAt: r.createdAt, reason: r.reason }));
  }

  /**
   * Job: tells players (and their server) that a grant just ended. Correctness does not depend on this running –
   * `effectiveFor` already treats an expired grant as gone – it only keeps notifications and server state tidy.
   */
  async processExpired(): Promise<number> {
    const now = this.clock.now();
    const expired = await this.prisma.skinPermission.findMany({
      where: { revokedAt: null, supersededAt: null, expiresAt: { lte: now, gt: new Date(now.getTime() - 24 * 3600_000) } },
      select: { id: true, userId: true },
    });
    let handled = 0;
    for (const grant of expired) {
      if (!(await this.redis.setIfAbsent(`skinperm:expired:${grant.id}`, 48 * 3600_000))) continue;
      await this.notifications.notify({ userId: grant.userId, type: 'skin.permission_expired', title: 'Your skin access has ended' });
      await this.refreshOnServer(grant.userId);
      handled++;
    }
    return handled;
  }

  /** In-game `!skch LEVEL all` and the web panel both end up here for every affected player. */
  async grantToMany(userIds: readonly string[], level: number, durationMinutes: number | undefined, actor: GrantActor): Promise<number> {
    let count = 0;
    for (const userId of userIds) {
      await this.grant(
        {
          userId,
          level,
          stickerCrafts: false,
          floatEditing: false,
          customLoadouts: true,
          duration: durationMinutes ? 'custom' : 'permanent',
          customMinutes: durationMinutes,
        },
        actor,
      );
      count++;
    }
    return count;
  }

  private assertMayGrant(actor: GrantActor, level: number): void {
    if (!actor.permissions.has('skin.assign')) throw forbidden('You may not assign skin access', 'MISSING_PERMISSION');
    if (level > maxGrantableSkinLevel(actor.permissions)) throw forbidden(`You can grant skin levels up to ${maxGrantableSkinLevel(actor.permissions)}`, 'SKIN_LEVEL_NOT_ALLOWED');
  }

  /** Tells the server hosting the player's open match to reload that player's skins. */
  private async refreshOnServer(userId: string): Promise<void> {
    const player = await this.prisma.matchPlayer.findFirst({
      where: { userId, removedAt: null, match: { status: { in: ['LOBBY', 'VETO', 'MAP_FORCED', 'CONFIGURING', 'LIVE'] }, serverId: { not: null } } },
      include: { match: { select: { id: true, serverId: true } } },
    });
    if (!player?.match.serverId) return;
    await this.commands.issue({ serverId: player.match.serverId, matchId: player.match.id, type: 'PLAYER_REFRESH_SKINS', payload: { steamId: player.steamId } }).catch((error: Error) => this.logger.warn(`Could not queue skin refresh: ${error.message}`));
  }
}

function summarise(p: EffectiveSkinPermission) {
  return { level: p.level, stickerCrafts: p.stickerCrafts, floatEditing: p.floatEditing, customLoadouts: p.customLoadouts, expiresAt: p.expiresAt?.toISOString() ?? null, source: p.source };
}
