import { Injectable } from '@nestjs/common';
import { DEFAULT_RANK_TIERS, resolveRank, type RankTier } from '@celtist/shared';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const CACHE_KEY = 'ranking:tiers';
const CACHE_SECONDS = 120;

export interface RankBadge {
  key: string;
  name: string;
  color: string;
}

/** Rank tiers are admin-editable data; this service reads them (cached) and turns an Elo into a badge. */
@Injectable()
export class RankTiersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async tiers(): Promise<RankTier[]> {
    const tiers = await this.redis.remember<RankTier[]>(CACHE_KEY, CACHE_SECONDS, async () => {
      const rows = await this.prisma.rankTier.findMany({ orderBy: { minElo: 'asc' } });
      return rows.map((r) => ({ key: r.key, name: r.name, minElo: r.minElo, color: r.color, position: r.position }));
    });
    return tiers.length > 0 ? tiers : [...DEFAULT_RANK_TIERS];
  }

  async badgeFor(elo: number, tiers?: readonly RankTier[]): Promise<RankBadge> {
    const tier = resolveRank(elo, tiers ?? (await this.tiers()));
    return { key: tier.key, name: tier.name, color: tier.color };
  }

  async invalidate(): Promise<void> {
    await this.redis.client.del(CACHE_KEY).catch(() => undefined);
  }
}
