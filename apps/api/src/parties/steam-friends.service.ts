import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { HTTP_FETCH, type HttpFetch } from '../steam/steam-openid.service.js';

const FRIENDS_URL = 'https://api.steampowered.com/ISteamUser/GetFriendList/v1/';
const CACHE_SECONDS = 300;

export interface SteamFriendsView {
  /** false when the Steam friend list is private (or Steam is unreachable) – nothing can be shown then. */
  available: boolean;
  reason?: 'PRIVATE' | 'UNAVAILABLE';
  friends: Array<{ steamId: string; displayName: string; avatarUrl: string | null }>;
}

/** The caller's Steam friends who are registered on the platform (so they can be invited to a party). */
@Injectable()
export class SteamFriendsService {
  private readonly logger = new Logger(SteamFriendsService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(HTTP_FETCH) private readonly fetcher: HttpFetch,
  ) {}

  async friendsOf(userId: string): Promise<SteamFriendsView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { steamId: true } });
    const ids = await this.friendIds(user.steamId);
    if (ids === 'PRIVATE' || ids === 'UNAVAILABLE') return { available: false, reason: ids, friends: [] };
    const users = await this.prisma.user.findMany({
      where: { steamId: { in: ids } },
      select: { steamId: true, displayName: true, avatarUrl: true },
      orderBy: { displayName: 'asc' },
    });
    return { available: true, friends: users };
  }

  private async friendIds(steamId: string): Promise<string[] | 'PRIVATE' | 'UNAVAILABLE'> {
    const key = `steam:friends:${steamId}`;
    const cached = await this.redis.getJson<string[] | 'PRIVATE'>(key);
    if (cached) return cached;
    if (!this.config.env.STEAM_API_KEY) return 'UNAVAILABLE';
    try {
      // The Steam Web API only accepts the key as a query parameter; the URL is never logged.
      const url = new URL(FRIENDS_URL);
      url.searchParams.set('key', this.config.env.STEAM_API_KEY);
      url.searchParams.set('steamid', steamId);
      url.searchParams.set('relationship', 'friend');
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(8000) });
      // 401 = the friend list of this profile is not public
      if (response.status === 401 || response.status === 403) {
        await this.redis.setJson(key, 'PRIVATE', CACHE_SECONDS);
        return 'PRIVATE';
      }
      if (!response.ok) throw new Error(`Steam Web API answered ${response.status}`);
      const body = (await response.json()) as { friendslist?: { friends?: Array<{ steamid: string }> } };
      const ids = (body.friendslist?.friends ?? []).map((f) => f.steamid);
      await this.redis.setJson(key, ids, CACHE_SECONDS);
      return ids;
    } catch (error) {
      this.logger.warn(`Steam friend list failed: ${(error as Error).message}`);
      return 'UNAVAILABLE';
    }
  }
}
