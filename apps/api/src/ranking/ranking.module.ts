import { Module } from '@nestjs/common';
import { RankTiersService } from './rank-tiers.service.js';
import { RankingService } from './ranking.service.js';

@Module({ providers: [RankingService, RankTiersService], exports: [RankingService, RankTiersService] })
export class RankingModule {}
