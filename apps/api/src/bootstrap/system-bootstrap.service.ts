import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ensureSystemData } from '@celtist/database';
import { PrismaService } from '../database/prisma.service.js';

/** Makes sure roles, rank tiers, default maps and setting defaults exist (idempotent, never overwrites edits). */
@Injectable()
export class SystemBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.run();
    } catch {
      // Two instances starting at once can race on the unique keys; the second attempt then finds the rows.
      await this.run();
    }
  }

  private async run(): Promise<void> {
    const result = await ensureSystemData(this.prisma);
    const created =
      result.rolesCreated.length + result.rankTiersCreated + result.mapsCreated + result.mapPoolsCreated + result.settingsCreated.length;
    if (created > 0) this.logger.log(`System data created: ${JSON.stringify(result)}`);
  }
}

@Module({ providers: [SystemBootstrapService] })
export class SystemBootstrapModule {}
