import { Global, Module } from '@nestjs/common';
import type { AppEnv } from './env.js';
import { loadEnv } from './env.js';

/** Validated, immutable application configuration (injectable). */
export class AppConfig {
  constructor(readonly env: Readonly<AppEnv>) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  /** Cookies are Secure whenever the API is served over https. */
  get cookieSecure(): boolean {
    return this.env.PUBLIC_API_URL.startsWith('https://');
  }

  get webOrigin(): string {
    return new URL(this.env.PUBLIC_WEB_URL).origin;
  }

  /** Origins allowed to call the API with credentials: the web app plus CORS_ORIGINS. */
  get allowedOrigins(): string[] {
    return [...new Set([this.webOrigin, ...this.env.CORS_ORIGINS.map((o) => new URL(o).origin)])];
  }
}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig(loadEnv()) }],
  exports: [AppConfig],
})
export class ConfigModule {
  /** Used by tests to supply a fixed configuration. */
  static forTest(env: AppEnv) {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: AppConfig, useValue: new AppConfig(env) }],
      exports: [AppConfig],
    };
  }
}
