import { Module } from '@nestjs/common';
import { MapsModule } from '../maps/maps.module.js';
import { MatchCoreModule } from '../matches/core/match-core.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';

@Module({
  imports: [MapsModule, MatchCoreModule, MatchesModule],
  controllers: [PartiesController],
  providers: [PartiesService],
  exports: [PartiesService],
})
export class PartiesModule {}
