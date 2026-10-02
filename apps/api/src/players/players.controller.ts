import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { GAME_MODES, steamId64Schema } from '@celtist/shared';
import { Public } from '../security/access.js';
import { RankTiersService } from '../ranking/rank-tiers.service.js';
import { LeaderboardService } from './leaderboard.service.js';
import { PlayersService } from './players.service.js';

const steamParam = steamId64Schema;
const searchQuery = z.object({
  q: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const statsQuery = z.object({
  window: z.enum(['overall', '30d', 'last']).default('overall'),
  mode: z.enum(GAME_MODES).optional(),
});
const rankingQuery = z.object({
  scope: z.enum(['global', '30d', 'tournament', 'wingman']).default('global'),
  sort: z.enum(['elo', 'wins', 'winrate', 'kd', 'kills']).default('elo'),
  minMatches: z.coerce.number().int().min(0).max(1000).default(1),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('players')
export class PlayersController {
  constructor(private readonly players: PlayersService) {}

  @Get()
  @Public()
  search(@Query({ schema: searchQuery }) query: z.infer<typeof searchQuery>) {
    return this.players.search(query);
  }

  @Get(':steamId')
  @Public()
  profile(@Param('steamId', { schema: steamParam }) steamId: string) {
    return this.players.profile(steamId);
  }

  @Get(':steamId/stats')
  @Public()
  stats(@Param('steamId', { schema: steamParam }) steamId: string, @Query({ schema: statsQuery }) query: z.infer<typeof statsQuery>) {
    return this.players.stats(steamId, query.window, query.mode);
  }

  @Get(':steamId/matches')
  @Public()
  matches(@Param('steamId', { schema: steamParam }) steamId: string, @Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    return this.players.history(steamId, query.page, query.pageSize);
  }

  @Get(':steamId/tournaments')
  @Public()
  tournaments(@Param('steamId', { schema: steamParam }) steamId: string) {
    return this.players.tournaments(steamId);
  }
}

@Controller('ranking')
export class RankingController {
  constructor(
    private readonly leaderboard: LeaderboardService,
    private readonly tiers: RankTiersService,
  ) {}

  @Get()
  @Public()
  board(@Query({ schema: rankingQuery }) query: z.infer<typeof rankingQuery>) {
    return this.leaderboard.leaderboard(query);
  }

  @Get('tiers')
  @Public()
  async tierList() {
    return { tiers: await this.tiers.tiers() };
  }
}
