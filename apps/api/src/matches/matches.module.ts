import { Module } from '@nestjs/common';
import { MapsModule } from '../maps/maps.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { TournamentsCoreModule } from '../tournaments/tournaments-core.module.js';
import { MatchCoreModule } from './core/match-core.module.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchConfigService } from './match-config.service.js';
import { MatchAccessService, MatchControlService } from './match-control.service.js';
import { MatchFinalizerService } from './match-finalizer.service.js';
import { MatchLifecycleService } from './match-lifecycle.service.js';
import { MatchTicker } from './match-ticker.service.js';
import { MatchVetoService } from './match-veto.service.js';
import { AdminMatchesController, MatchControlController, MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';
import { ServerGatewayController } from './server-gateway.controller.js';
import { MatchAutomationListener, ServerEventsService } from './server-events.service.js';

@Module({
  imports: [ServersModule, RankingModule, MapsModule, MatchCoreModule, TournamentsCoreModule],
  controllers: [MatchesController, MatchControlController, AdminMatchesController, ServerGatewayController],
  providers: [
    MatchesService,
    MatchConfigService,
    MatchCommandService,
    MatchLifecycleService,
    MatchVetoService,
    MatchFinalizerService,
    MatchAccessService,
    MatchControlService,
    ServerEventsService,
    MatchAutomationListener,
    MatchTicker,
  ],
  exports: [MatchesService, MatchLifecycleService, MatchFinalizerService, MatchCommandService, MatchControlService, MatchAccessService, MatchTicker],
})
export class MatchesModule {}
