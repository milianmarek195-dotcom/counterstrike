import { Injectable, Logger } from '@nestjs/common';
import { GAME_MODES } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { PermissionResolver } from '../security/permission-resolver.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { SteamProfileSource, type SteamProfileData } from '../steam/steam-profile.source.js';

export interface SignedInUser {
  id: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  isNew: boolean;
}

/** Creates and refreshes platform accounts from Steam identities. */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly steamProfiles: SteamProfileSource,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionResolver,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  /**
   * Called after Steam confirmed the identity. Creates the account on first login (with rank/stat rows for both
   * game modes), refreshes name/avatar, and grants the Owner role to configured bootstrap SteamIDs.
   */
  async upsertFromSteamLogin(steamId: string): Promise<SignedInUser> {
    const profile = await this.fetchProfileSafely(steamId);
    const now = this.clock.now();
    const existing = await this.prisma.user.findUnique({ where: { steamId }, select: { id: true, displayName: true, avatarUrl: true } });

    const displayName = profile?.personaName ?? existing?.displayName ?? `Player ${steamId.slice(-4)}`;
    const avatarUrl = profile?.avatarFull ?? profile?.avatarMedium ?? existing?.avatarUrl ?? null;

    const user = await this.prisma.user.upsert({
      where: { steamId },
      create: { steamId, displayName, avatarUrl, lastLoginAt: now },
      update: { displayName, avatarUrl, lastLoginAt: now },
    });
    if (profile) await this.saveSteamProfile(user.id, profile);

    await this.ensureRankRows(user.id);
    await this.ensureOwnerRole(user.id, steamId);
    await this.ensureWelcomeSkinGrant(user.id, displayName);

    return { id: user.id, steamId, displayName, avatarUrl, isNew: existing === null };
  }

  /**
   * Welcome gift: a time-limited skin level for accounts that never had any skin permission (new accounts, and old
   * ones the first time they sign in after the feature exists). Configurable and switchable in the platform settings.
   */
  async ensureWelcomeSkinGrant(userId: string, displayName: string): Promise<void> {
    const cfg = await this.settings.get('skin.welcomeGrant');
    if (!cfg.enabled || cfg.level <= 0) return;
    if (await this.prisma.skinPermission.findFirst({ where: { userId }, select: { id: true } })) return;
    const expiresAt = new Date(this.clock.nowMs() + cfg.days * 86_400_000);
    await this.prisma.skinPermission.create({
      data: { userId, level: cfg.level, floatEditing: cfg.floatEditing, stickerCrafts: cfg.stickerCrafts, customLoadouts: true, reason: 'Willkommensgeschenk', expiresAt },
    });
    await this.prisma.auditLog.create({
      data: { actorLabel: 'system', action: 'player.skin_level.set', targetType: 'user', targetId: userId, targetLabel: displayName, reason: 'Willkommensgeschenk', newValue: { level: cfg.level, days: cfg.days }, metadata: { via: 'welcome-grant' } },
    });
  }

  /** One rank row and one stats row per game mode, created with the configured start Elo. */
  async ensureRankRows(userId: string): Promise<void> {
    const elo = await this.settings.get('elo.config');
    await this.prisma.playerRank.createMany({
      data: GAME_MODES.map((mode) => ({ userId, mode, elo: elo.startElo, peakElo: elo.startElo })),
      skipDuplicates: true,
    });
    await this.prisma.playerStats.createMany({
      data: GAME_MODES.map((mode) => ({ userId, mode })),
      skipDuplicates: true,
    });
  }

  private async ensureOwnerRole(userId: string, steamId: string): Promise<void> {
    if (!this.config.env.OWNER_STEAM_IDS.includes(steamId)) return;
    const role = await this.prisma.role.findUnique({ where: { key: 'owner' }, select: { id: true } });
    if (!role) {
      this.logger.warn('Owner role does not exist yet; cannot grant it');
      return;
    }
    const result = await this.prisma.userRole.createMany({ data: [{ userId, roleId: role.id }], skipDuplicates: true });
    if (result.count > 0) {
      await this.permissions.invalidateUser(userId);
      this.logger.log(`Granted the Owner role to bootstrap user ${steamId}`);
    }
  }

  private async fetchProfileSafely(steamId: string): Promise<SteamProfileData | null> {
    try {
      return (await this.steamProfiles.fetchProfiles([steamId])).get(steamId) ?? null;
    } catch (error) {
      this.logger.warn(`Steam profile lookup failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async saveSteamProfile(userId: string, profile: SteamProfileData): Promise<void> {
    const data = {
      personaName: profile.personaName,
      avatarSmall: profile.avatarSmall,
      avatarMedium: profile.avatarMedium,
      avatarFull: profile.avatarFull,
      profileUrl: profile.profileUrl,
      countryCode: profile.countryCode,
      visibilityState: profile.visibilityState,
      accountCreatedAt: profile.accountCreatedAt,
      lastSyncedAt: this.clock.now(),
    };
    await this.prisma.steamProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }
}
