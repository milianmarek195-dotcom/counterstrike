import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RedisService } from '../redis/redis.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SkinPermissionsService } from './skin-permissions.service.js';

/** Admin-configured prize: the top fraggers of the winning team get skin changer access for some days. */
@Injectable()
export class MatchRewardsService {
  private readonly logger = new Logger(MatchRewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly redis: RedisService,
    private readonly permissions: SkinPermissionsService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(DomainEvent.MatchFinished)
  async onMatchFinished(payload: MatchEventPayload): Promise<void> {
    try {
      await this.reward(payload.matchId);
    } catch (error) {
      this.logger.error(`Reward for match ${payload.matchId} failed: ${(error as Error).message}`);
    }
  }

  /** Returns the rewarded user ids (empty when disabled, no winner, or already paid out). */
  async reward(matchId: string): Promise<string[]> {
    const cfg = await this.settings.get('match.topFraggerReward');
    if (!cfg.enabled) return [];
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, select: { kind: true, status: true, winnerSlot: true } });
    if (!match || match.status !== 'FINISHED' || !match.winnerSlot) return [];
    if (cfg.tournamentsOnly && match.kind !== 'TOURNAMENT') return [];
    if (!(await this.redis.setIfAbsent(`reward:match:${matchId}`, 30 * 86_400_000))) return [];

    const winners = await this.prisma.matchPlayer.findMany({
      where: { matchId, removedAt: null, matchTeam: { slot: match.winnerSlot } },
      orderBy: [{ kills: 'desc' }, { deaths: 'asc' }, { assists: 'desc' }, { id: 'asc' }],
      take: cfg.topN,
      include: { user: { select: { id: true, displayName: true } } },
    });
    const rewarded: string[] = [];
    for (const [index, w] of winners.entries()) {
      if (w.kills <= 0) continue; // a "top fragger" without a single kill earns nothing
      const current = await this.permissions.effectiveFor(w.userId);
      if (current.level >= cfg.level && current.expiresAt === null && current.source === 'grant') continue; // already permanent
      const expiresAt = new Date(Math.max(this.clock.nowMs() + cfg.days * 86_400_000, current.level >= cfg.level ? (current.expiresAt?.getTime() ?? 0) : 0));
      const level = Math.max(cfg.level, current.level);
      const reason = `Top-${index + 1}-Fragger (${w.kills} Kills) im Siegerteam`;
      await this.prisma.$transaction(async (tx) => {
        const latest = await tx.skinPermission.findFirst({ where: { userId: w.userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        const createdAt = latest && latest.createdAt.getTime() >= this.clock.nowMs() ? new Date(latest.createdAt.getTime() + 1) : this.clock.now();
        await tx.skinPermission.updateMany({ where: { userId: w.userId, supersededAt: null, revokedAt: null }, data: { supersededAt: createdAt } });
        await tx.skinPermission.create({
          data: { userId: w.userId, level, floatEditing: current.floatEditing || level >= 2, stickerCrafts: current.stickerCrafts, customLoadouts: true, reason, expiresAt, createdAt },
        });
        await tx.auditLog.create({
          data: { actorLabel: 'system', action: 'player.skin_level.set', targetType: 'user', targetId: w.userId, targetLabel: w.user.displayName, reason, newValue: { level, days: cfg.days, matchId }, metadata: { via: 'match-reward' } },
        });
      });
      await this.notifications.notify({ userId: w.userId, type: 'skin.permission', title: `Preis: Skin-Changer Level ${level} für ${cfg.days} Tage`, data: { level, expiresAt, matchId } });
      rewarded.push(w.userId);
    }
    return rewarded;
  }
}
