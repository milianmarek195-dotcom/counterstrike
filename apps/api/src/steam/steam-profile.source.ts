import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch } from './steam-openid.service.js';

export interface SteamProfileData {
  steamId: string;
  personaName: string;
  avatarSmall: string | null;
  avatarMedium: string | null;
  avatarFull: string | null;
  profileUrl: string | null;
  countryCode: string | null;
  visibilityState: number;
  accountCreatedAt: Date | null;
}

/** Where Steam profile data comes from (interface so tests and offline development can substitute it). */
export abstract class SteamProfileSource {
  /** Returns the profiles Steam knows; missing ids are simply absent from the map. Never throws on "not found". */
  abstract fetchProfiles(steamIds: readonly string[]): Promise<Map<string, SteamProfileData>>;
}

const SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const BATCH_SIZE = 100;

interface PlayerSummary {
  steamid: string;
  personaname?: string;
  avatar?: string;
  avatarmedium?: string;
  avatarfull?: string;
  profileurl?: string;
  loccountrycode?: string;
  communityvisibilitystate?: number;
  timecreated?: number;
}

@Injectable()
export class SteamWebApiProfileSource extends SteamProfileSource {
  private readonly logger = new Logger(SteamWebApiProfileSource.name);

  constructor(
    private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetcher: HttpFetch,
  ) {
    super();
  }

  override async fetchProfiles(steamIds: readonly string[]): Promise<Map<string, SteamProfileData>> {
    const result = new Map<string, SteamProfileData>();
    for (let i = 0; i < steamIds.length; i += BATCH_SIZE) {
      const batch = steamIds.slice(i, i + BATCH_SIZE);
      // The Steam Web API only accepts the key as a query parameter; the URL is never logged.
      const url = new URL(SUMMARIES_URL);
      url.searchParams.set('key', this.config.env.STEAM_API_KEY ?? '');
      url.searchParams.set('steamids', batch.join(','));
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Steam Web API answered ${response.status}`);
      const body = (await response.json()) as { response?: { players?: PlayerSummary[] } };
      for (const player of body.response?.players ?? []) {
        result.set(player.steamid, {
          steamId: player.steamid,
          personaName: (player.personaname ?? '').trim().slice(0, 64) || `Player ${player.steamid.slice(-4)}`,
          avatarSmall: httpsOnly(player.avatar),
          avatarMedium: httpsOnly(player.avatarmedium),
          avatarFull: httpsOnly(player.avatarfull),
          profileUrl: httpsOnly(player.profileurl),
          countryCode: player.loccountrycode?.slice(0, 2).toUpperCase() ?? null,
          visibilityState: player.communityvisibilitystate ?? 1,
          accountCreatedAt: player.timecreated ? new Date(player.timecreated * 1000) : null,
        });
      }
    }
    return result;
  }
}

/** Used when no STEAM_API_KEY is configured (local development): players get a placeholder profile. */
@Injectable()
export class OfflineSteamProfileSource extends SteamProfileSource {
  private readonly logger = new Logger(OfflineSteamProfileSource.name);
  private warned = false;

  override async fetchProfiles(): Promise<Map<string, SteamProfileData>> {
    if (!this.warned) {
      this.logger.warn('STEAM_API_KEY is not set: Steam names and avatars are not available');
      this.warned = true;
    }
    return new Map();
  }
}

function httpsOnly(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}
