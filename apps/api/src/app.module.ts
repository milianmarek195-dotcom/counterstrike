import { DynamicModule, Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { AuditModule } from './audit/audit.service.js';
import { AuthModule } from './auth/auth.module.js';
import { MapsModule } from './maps/maps.module.js';
import { MatchesModule } from './matches/matches.module.js';
import { NotificationsModule } from './notifications/notifications.service.js';
import { PartiesModule } from './parties/parties.module.js';
import { PlayersModule } from './players/players.module.js';
import { ServersModule } from './servers/servers.module.js';
import { SkinsModule } from './skins/skins.module.js';
import { TournamentsModule } from './tournaments/tournaments.module.js';
import { SystemBootstrapModule } from './bootstrap/system-bootstrap.service.js';
import { CoreModule } from './core/core.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { SettingsModule } from './settings/settings.service.js';
import { SteamModule } from './steam/steam.module.js';

export interface AppModuleOptions {
  /** Start BullMQ workers and schedulers in this process (APP_ROLE = all | worker). */
  jobs: boolean;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggingModule,
        CoreModule,
        SettingsModule,
        AuditModule,
        SteamModule,
        SystemBootstrapModule,
        AuthModule,
        MapsModule,
        ServersModule,
        MatchesModule,
        TournamentsModule,
        PlayersModule,
        NotificationsModule,
        PartiesModule,
        SkinsModule,
        AdminModule,
        TeamsModule,
        RealtimeModule,
        ...(options.jobs ? [JobsModule] : []),
      ],
    };
  }
}
