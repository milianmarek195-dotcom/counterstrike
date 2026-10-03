import { Module } from '@nestjs/common';
import { MapsModule } from '../maps/maps.module.js';
import { MatchCoreModule } from '../matches/core/match-core.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { PartiesController } from './parties.controller.js';
import { PartiesService } from './parties.service.js';
import { SteamFriendsService } from './steam-friends.service.js';
import { SteamModule } from '../steam/steam.module.js';

@Module({
  imports: [SteamModule, MapsModule, MatchCoreModule, MatchesModule],
  controllers: [PartiesController],
  providers: [PartiesService, SteamFriendsService],
  exports: [PartiesService],
})
export class PartiesModule {}
