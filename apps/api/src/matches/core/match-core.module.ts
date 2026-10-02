import { Module } from '@nestjs/common';
import { MatchFactory } from './match-factory.service.js';

/** Match-row creation shared by tournaments, matchmaking and admin tools (kept free of lifecycle logic to avoid module cycles). */
@Module({ providers: [MatchFactory], exports: [MatchFactory] })
export class MatchCoreModule {}
