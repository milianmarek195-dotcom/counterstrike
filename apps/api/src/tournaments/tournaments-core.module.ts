import { Module } from '@nestjs/common';
import { MatchCoreModule } from '../matches/core/match-core.module.js';
import { BracketProgressionService } from './bracket-progression.service.js';

/** Bracket persistence/progression, usable by the match finalizer without importing the tournament controllers. */
@Module({
  imports: [MatchCoreModule],
  providers: [BracketProgressionService],
  exports: [BracketProgressionService],
})
export class TournamentsCoreModule {}
