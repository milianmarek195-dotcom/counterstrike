import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { Clock } from '../common/clock.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { MatchTicker } from '../matches/match-ticker.service.js';
import { SessionService } from '../security/session.service.js';
import { SkinPermissionsService } from '../skins/skin-permissions.service.js';
import { SkinSyncService } from '../skins/skin-sync.service.js';

const QUEUE = 'celtist-maintenance';
const EVENT_RETENTION_DAYS = 30;

/** name → schedule. Every handler is idempotent, so a repeated or overlapping run is harmless. */
export const JOB_SCHEDULES: Record<string, { everyMs: number }> = {
  'match-tick': { everyMs: 5_000 },
  'skin-permission-expiry': { everyMs: 60_000 },
  'session-purge': { everyMs: 3_600_000 },
  'server-event-cleanup': { everyMs: 6 * 3_600_000 },
  'skin-price-sync': { everyMs: 6 * 3_600_000 },
  'skin-catalog-sync': { everyMs: 24 * 3_600_000 },
};

/**
 * Runs the background work through BullMQ so that exactly one worker executes each run, even with several API
 * instances. Only started when the process has the "all" or "worker" role.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly ticker: MatchTicker,
    private readonly sessions: SessionService,
    private readonly skinPermissions: SkinPermissionsService,
    private readonly skinSync: SkinSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connect = () => {
      const c = new Redis(this.config.env.REDIS_URL, { maxRetriesPerRequest: null });
      this.connections.push(c);
      return c;
    };
    this.queue = new Queue(QUEUE, { connection: connect() });
    for (const [name, { everyMs }] of Object.entries(JOB_SCHEDULES)) {
      await this.queue.upsertJobScheduler(name, { every: everyMs }, { name, opts: { removeOnComplete: 20, removeOnFail: 50, attempts: 1 } });
    }
    this.worker = new Worker(QUEUE, (job) => this.run(job.name), { connection: connect(), concurrency: 2 });
    this.worker.on('failed', (job: Job | undefined, error: Error) => this.logger.error(`Job ${job?.name ?? '?'} failed: ${error.message}`));
    this.logger.log(`Background jobs started (${Object.keys(JOB_SCHEDULES).length} schedules)`);
  }

  /** Exposed so tests and the admin tooling can run a job directly. */
  async run(name: string): Promise<unknown> {
    switch (name) {
      case 'match-tick':
        return this.ticker.runOnce();
      case 'skin-permission-expiry':
        return this.skinPermissions.processExpired();
      case 'session-purge':
        return this.sessions.purgeExpired();
      case 'server-event-cleanup':
        return this.cleanupServerEvents();
      case 'skin-price-sync':
        return this.skinSync.syncPrices();
      case 'skin-catalog-sync':
        return this.skinSync.syncCatalog();
      default:
        throw new Error(`Unknown job ${name}`);
    }
  }

  async cleanupServerEvents(): Promise<number> {
    const cutoff = new Date(this.clock.nowMs() - EVENT_RETENTION_DAYS * 86_400_000);
    const { count } = await this.prisma.serverEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    return count;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    for (const c of this.connections) c.disconnect();
  }
}
