import { Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { MatchesModule } from '../matches/matches.module.js';
import { InventoryService } from './inventory.service.js';
import { LoadoutsService } from './loadouts.service.js';
import { SkinCatalogSource, SkinPriceProvider } from './skin-catalog.js';
import { MatchRewardsService } from './match-rewards.service.js';
import { SkinPermissionsService } from './skin-permissions.service.js';
import { CsgoApiCatalogSource, NoPriceProvider, SkinportPriceProvider } from './skin-sources.js';
import { SkinSyncService } from './skin-sync.service.js';
import { AdminSkinsController, InventoryController, LoadoutsController, SkinsController, SkinsGatewayController } from './skins.controller.js';
import { SkinsService } from './skins.service.js';

@Module({
  imports: [MatchesModule],
  controllers: [SkinsController, InventoryController, LoadoutsController, AdminSkinsController, SkinsGatewayController],
  providers: [
    SkinsService,
    MatchRewardsService,
    SkinPermissionsService,
    InventoryService,
    LoadoutsService,
    SkinSyncService,
    CsgoApiCatalogSource,
    SkinportPriceProvider,
    NoPriceProvider,
    { provide: SkinCatalogSource, useExisting: CsgoApiCatalogSource },
    {
      provide: SkinPriceProvider,
      inject: [AppConfig, SkinportPriceProvider, NoPriceProvider],
      useFactory: (config: AppConfig, skinport: SkinportPriceProvider, none: NoPriceProvider) => (config.env.SKIN_PRICE_PROVIDER === 'skinport' ? skinport : none),
    },
  ],
  exports: [SkinsService, SkinPermissionsService, InventoryService, LoadoutsService, SkinSyncService],
})
export class SkinsModule {}
