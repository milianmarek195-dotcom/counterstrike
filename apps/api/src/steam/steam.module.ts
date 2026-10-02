import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, SteamOpenIdService, type HttpFetch } from './steam-openid.service.js';
import { OfflineSteamProfileSource, SteamProfileSource, SteamWebApiProfileSource } from './steam-profile.source.js';

@Global()
@Module({
  providers: [
    { provide: HTTP_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies HttpFetch },
    SteamOpenIdService,
    SteamWebApiProfileSource,
    OfflineSteamProfileSource,
    {
      provide: SteamProfileSource,
      inject: [AppConfig, SteamWebApiProfileSource, OfflineSteamProfileSource],
      useFactory: (config: AppConfig, web: SteamWebApiProfileSource, offline: OfflineSteamProfileSource) =>
        config.env.STEAM_API_KEY ? web : offline,
    },
  ],
  exports: [HTTP_FETCH, SteamOpenIdService, SteamProfileSource],
})
export class SteamModule {}
