import { Module } from '@nestjs/common';
import { MatchesModule } from '../matches/matches.module.js';
import { SkinsModule } from '../skins/skins.module.js';
import { JobsService } from './jobs.service.js';

@Module({ imports: [MatchesModule, SkinsModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
