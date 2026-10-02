import { Module } from '@nestjs/common';
import { MapsModule } from '../maps/maps.module.js';
import { MatchesModule } from '../matches/matches.module.js';
import { TournamentTeamsService } from './tournament-teams.service.js';
import { AdminTournamentsController, TournamentsController } from './tournaments.controller.js';
import { TournamentsCoreModule } from './tournaments-core.module.js';
import { TournamentsService } from './tournaments.service.js';

@Module({
  imports: [MapsModule, MatchesModule, TournamentsCoreModule],
  controllers: [TournamentsController, AdminTournamentsController],
  providers: [TournamentsService, TournamentTeamsService],
  exports: [TournamentsService, TournamentTeamsService],
})
export class TournamentsModule {}
