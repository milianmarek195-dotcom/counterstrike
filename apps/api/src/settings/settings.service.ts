import { Global, Injectable, Module } from '@nestjs/common';
import {
  SETTING_KEYS,
  isSettingKey,
  parseSetting,
  validateSetting,
  type SettingKey,
  type SettingValue,
} from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { badRequest } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';

const CACHE_MS = 15_000;

/** Typed access to PlatformSetting rows with defaults and a short in-process cache. */
@Injectable()
export class SettingsService {
  private cache: { loadedAt: number; values: Map<string, unknown> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const values = await this.load();
    return parseSetting(key, values.get(key));
  }

  async all(): Promise<Record<SettingKey, unknown>> {
    const values = await this.load();
    return Object.fromEntries(SETTING_KEYS.map((key) => [key, parseSetting(key, values.get(key))])) as Record<SettingKey, unknown>;
  }

  /** Validates against the setting's schema and stores it. Returns the previous and new value for auditing. */
  async set(key: string, value: unknown, actorId: string | null): Promise<{ key: SettingKey; oldValue: unknown; newValue: unknown }> {
    if (!isSettingKey(key)) throw badRequest('UNKNOWN_SETTING', `Unknown setting "${key}"`);
    const checked = validateSetting(key, value);
    if (!checked.ok) throw badRequest('INVALID_SETTING', 'The value is not valid for this setting', checked.issues);
    const oldValue = await this.get(key);
    await this.prisma.platformSetting.upsert({
      where: { key },
      create: { key, value: checked.value as never, updatedById: actorId },
      update: { value: checked.value as never, updatedById: actorId },
    });
    this.cache = null;
    return { key, oldValue, newValue: checked.value };
  }

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<Map<string, unknown>> {
    const now = this.clock.nowMs();
    if (this.cache && now - this.cache.loadedAt < CACHE_MS) return this.cache.values;
    const rows = await this.prisma.platformSetting.findMany();
    this.cache = { loadedAt: now, values: new Map(rows.map((r) => [r.key, r.value])) };
    return this.cache.values;
  }
}

@Global()
@Module({ providers: [SettingsService], exports: [SettingsService] })
export class SettingsModule {}
