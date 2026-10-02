import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module.js';
import { LeaderboardService } from './leaderboard.service.js';
import { PlayersController, RankingController } from './players.controller.js';
import { PlayersService } from './players.service.js';

@Module({
  imports: [RankingModule],
  controllers: [PlayersController, RankingController],
  providers: [PlayersService, LeaderboardService],
  exports: [PlayersService, LeaderboardService],
})
export class PlayersModule {}
