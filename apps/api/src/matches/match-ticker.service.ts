import { Injectable, Logger } from '@nestjs/common';
import { ServerHeartbeatService } from '../servers/server-heartbeat.service.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchLifecycleService } from './match-lifecycle.service.js';
import { MatchTimeLimitService } from './match-time-limit.service.js';
import { MatchVetoService } from './match-veto.service.js';

export interface TickResult {
  serversOffline: number;
  reservationsExpired: number;
  allocated: number;
  vetoTimeouts: number;
  commandsExpired: number;
  timeLimited: number;
}

/**
 * The time-driven part of the match system, run every few seconds by the job scheduler (and directly by tests).
 * Each step is independent and safe to repeat: they all re-check the database state they act on.
 */
@Injectable()
export class MatchTicker {
  private readonly logger = new Logger(MatchTicker.name);

  constructor(
    private readonly heartbeat: ServerHeartbeatService,
    private readonly lifecycle: MatchLifecycleService,
    private readonly veto: MatchVetoService,
    private readonly commands: MatchCommandService,
    private readonly timeLimit: MatchTimeLimitService,
  ) {}

  async runOnce(): Promise<TickResult> {
    const result: TickResult = { serversOffline: 0, reservationsExpired: 0, allocated: 0, vetoTimeouts: 0, commandsExpired: 0, timeLimited: 0 };
    result.serversOffline = await this.step('server offline check', () => this.heartbeat.markStaleOffline());
    result.reservationsExpired = await this.step('reservation expiry', () => this.lifecycle.expireReservations());
    result.vetoTimeouts = await this.step('veto timeouts', () => this.veto.processTimeouts());
    result.allocated = await this.step('server allocation', () => this.lifecycle.allocatePending());
    result.commandsExpired = await this.step('command expiry', () => this.commands.expireOld());
    result.timeLimited = await this.step('match time limit', () => this.timeLimit.enforce());
    return result;
  }

  private async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (error) {
      this.logger.error(`Tick step "${name}" failed: ${(error as Error).message}`);
      return 0;
    }
  }
}
