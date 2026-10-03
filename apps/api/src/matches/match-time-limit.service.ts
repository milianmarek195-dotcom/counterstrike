import { Injectable, Logger } from '@nestjs/common';
import type { TeamSlot } from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MatchFinalizerService } from './match-finalizer.service.js';
import { MatchLifecycleService } from './match-lifecycle.service.js';

const RUNNING = ['CONFIGURING', 'LIVE', 'SERVER_ERROR'] as const;
const SETUP = ['WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'] as const;

/** Which side leads: series score first, then the map being played. Null when level (or nothing to compare). */
export function leadingSlot(teams: ReadonlyArray<{ slot: string; seriesScore: number }>, liveMap?: { scoreA: number; scoreB: number } | null): TeamSlot | null {
  const a = teams.find((t) => t.slot === 'A')?.seriesScore ?? 0;
  const b = teams.find((t) => t.slot === 'B')?.seriesScore ?? 0;
  if (a !== b) return a > b ? 'A' : 'B';
  if (liveMap && liveMap.scoreA !== liveMap.scoreB) return liveMap.scoreA > liveMap.scoreB ? 'A' : 'B';
  return null;
}

/**
 * No match runs forever. After `match.maxDurationMinutes` (default 90, 0 = off) a match is closed:
 * party/custom matches (and lobbies nobody started) are cancelled, which frees the server and removes the players;
 * tournament matches are decided by the current score so the bracket can go on (ratings stay untouched).
 * A tournament match that is level stays for an admin.
 */
@Injectable()
export class MatchTimeLimitService {
  private readonly logger = new Logger(MatchTimeLimitService.name);
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly lifecycle: MatchLifecycleService,
    private readonly finalizer: MatchFinalizerService,
  ) {}

  async enforce(): Promise<number> {
    const minutes = await this.settings.get('match.maxDurationMinutes');
    if (!minutes) return 0;
    const cutoff = new Date(this.clock.nowMs() - minutes * 60_000);

    const overdue = await this.prisma.match.findMany({
      where: {
        OR: [
          { status: { in: [...RUNNING] }, startedAt: { lt: cutoff } },
          { status: { in: [...RUNNING] }, startedAt: null, createdAt: { lt: cutoff }, kind: { not: 'TOURNAMENT' } },
          { status: { in: [...SETUP] }, createdAt: { lt: cutoff }, kind: { not: 'TOURNAMENT' } },
        ],
      },
      include: { teams: { select: { slot: true, seriesScore: true } }, maps: { where: { status: 'LIVE' }, select: { scoreA: true, scoreB: true }, take: 1 } },
      take: 50,
    });

    let closed = 0;
    for (const match of overdue) {
      try {
        if (match.kind === 'TOURNAMENT') {
          const winner = leadingSlot(match.teams, match.maps[0]);
          if (!winner) {
            if (!this.warned.has(match.id)) {
              this.warned.add(match.id);
              this.logger.warn(`Tournament match ${match.id} passed the ${minutes} min limit while level: an admin has to decide it`);
            }
            continue;
          }
          if (await this.finalizer.decide(match.id, winner, `Zeitlimit von ${minutes} Minuten: entschieden nach Spielstand`)) closed++;
        } else if (await this.lifecycle.cancel(match.id, `Zeitlimit von ${minutes} Minuten erreicht`)) {
          closed++;
        }
      } catch (error) {
        this.logger.error(`Could not apply the time limit to match ${match.id}: ${(error as Error).message}`);
      }
    }
    if (closed > 0) this.logger.log(`Time limit closed ${closed} match(es)`);
    return closed;
  }
}
