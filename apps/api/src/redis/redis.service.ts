import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfig } from '../config/app-config.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) readonly client: Redis) {
    client.on('error', (error: Error) => this.logger.warn(`Redis error: ${error.message}`));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.client.del(key);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /**
   * Read-through cache. Redis outages never break a request: on any Redis error the loader result is
   * returned directly.
   */
  async remember<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.getJson<T>(key);
      if (cached !== null) return cached;
    } catch (error) {
      this.logger.warn(`Cache read failed for ${key}: ${(error as Error).message}`);
      return loader();
    }
    const value = await loader();
    try {
      await this.setJson(key, value, ttlSeconds);
    } catch (error) {
      this.logger.warn(`Cache write failed for ${key}: ${(error as Error).message}`);
    }
    return value;
  }

  /** Deletes every key with the given prefix (SCAN based, never KEYS). */
  async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) removed += await this.client.del(...keys);
    } while (cursor !== '0');
    return removed;
  }

  /** SET NX with expiry: true if the key was newly created (used for replay protection and locks). */
  async setIfAbsent(key: string, ttlMs: number, value = '1'): Promise<boolean> {
    return (await this.client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new Redis(config.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false }),
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class RedisModule {}
