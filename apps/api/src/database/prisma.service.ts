import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, createPrismaAdapter, type Prisma } from '@celtist/database';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({ adapter: createPrismaAdapter(config.env.DATABASE_URL, config.isTest ? 4 : 10) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Interactive transaction that retries on deadlocks and serialization failures (Postgres 40P01/40001, surfaced by
   * Prisma as P2034 / TransactionWriteConflict). The callback must therefore be safe to run more than once.
   * Lock order convention across the code base: match row first, then server/ranking rows.
   */
  async transact<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.$transaction(fn);
      } catch (error) {
        if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.random() * 30));
      }
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

export function isRetryableTransactionError(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ''} ${(error as Error)?.message ?? ''} ${JSON.stringify((error as { meta?: unknown })?.meta ?? '')}`;
  return /P2034|TransactionWriteConflict|deadlock|could not serialize|40001|40P01/i.test(text);
}

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
