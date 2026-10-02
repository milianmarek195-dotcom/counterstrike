import { Injectable } from '@nestjs/common';
import { Prisma, type GameMode, type TransactionClient } from '@celtist/database';
import { calculateMatchElo, type CombatStats, type EloOutcome, type EloResultRow } from '@celtist/shared';
import { SettingsService } from '../settings/settings.service.js';

export interface RatedPlayer {
  userId: string;
}

export interface ApplyEloInput {
  matchId: string;
  mode: GameMode;
  teamA: readonly RatedPlayer[];
  teamB: readonly RatedPlayer[];
  outcomeForA: EloOutcome;
}

export interface AppliedElo {
  rows: EloResultRow[];
  teamAElo: number;
  teamBElo: number;
}

/**
 * Applies rating and statistic changes. Every method takes the caller's transaction: ratings change in the
 * same atomic step as the match result, never separately. Double application is impossible because
 * (matchId, userId) is unique in elo_changes – a second attempt violates the constraint and rolls the whole
 * finalisation back.
 */
@Injectable()
export class RankingService {
  constructor(private readonly settings: SettingsService) {}

  async applyMatchElo(tx: TransactionClient, input: ApplyEloInput): Promise<AppliedElo> {
    const userIds = [...input.teamA, ...input.teamB].map((p) => p.userId);
    if (new Set(userIds).size !== userIds.length) throw new Error('A player cannot be on both teams');
    if (input.teamA.length === 0 || input.teamB.length === 0) throw new Error('Both teams need rated players');

    // Row locks in a fixed order: two matches finishing at the same time cannot deadlock or lose updates.
    const sorted = [...userIds].sort();
    await tx.$queryRaw(Prisma.sql`
      SELECT "userId" FROM "player_ranks"
      WHERE "mode" = ${input.mode}::"GameMode" AND "userId" IN (${Prisma.join(sorted.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "userId" FOR UPDATE`);

    const config = await this.settings.get('elo.config');
    const ranks = await tx.playerRank.findMany({ where: { mode: input.mode, userId: { in: userIds } } });
    const rankByUser = new Map(ranks.map((r) => [r.userId, r] as const));
    const toInput = (p: RatedPlayer) => {
      const rank = rankByUser.get(p.userId);
      if (!rank) throw new Error(`Player ${p.userId} has no ${input.mode} rank row`);
      return { userId: p.userId, elo: rank.elo, matchesPlayed: rank.matches };
    };

    const result = calculateMatchElo(input.teamA.map(toInput), input.teamB.map(toInput), input.outcomeForA, config);
    const now = new Date();

    for (const row of [...result.teamA, ...result.teamB]) {
      const rank = rankByUser.get(row.userId)!;
      await tx.eloChange.create({
        data: {
          matchId: input.matchId,
          userId: row.userId,
          mode: input.mode,
          outcome: row.outcome,
          eloBefore: row.eloBefore,
          eloAfter: row.eloAfter,
          delta: row.delta,
          kFactor: row.kFactor,
          expectedScore: row.expectedScore,
          ownTeamElo: row.ownTeamElo,
          opponentTeamElo: row.opponentTeamElo,
        },
      });

      const streak =
        row.outcome === 'WIN' ? (rank.currentStreak > 0 ? rank.currentStreak + 1 : 1) : row.outcome === 'LOSS' ? (rank.currentStreak < 0 ? rank.currentStreak - 1 : -1) : 0;
      await tx.playerRank.update({
        where: { userId_mode: { userId: row.userId, mode: input.mode } },
        data: {
          elo: row.eloAfter,
          peakElo: Math.max(rank.peakElo, row.eloAfter),
          currentStreak: streak,
          bestWinStreak: Math.max(rank.bestWinStreak, streak),
          wins: { increment: row.outcome === 'WIN' ? 1 : 0 },
          losses: { increment: row.outcome === 'LOSS' ? 1 : 0 },
          draws: { increment: row.outcome === 'DRAW' ? 1 : 0 },
          matches: { increment: 1 },
          lastMatchAt: now,
        },
      });
      await tx.matchPlayer.update({
        where: { matchId_userId: { matchId: input.matchId, userId: row.userId } },
        data: { eloBefore: row.eloBefore, eloAfter: row.eloAfter, eloDelta: row.delta },
      });
    }
    return { rows: [...result.teamA, ...result.teamB], teamAElo: result.teamAElo, teamBElo: result.teamBElo };
  }

  /** Adds a finished match's combat numbers to the player's career totals. */
  async applyMatchStats(tx: TransactionClient, mode: GameMode, players: ReadonlyArray<{ userId: string; stats: CombatStats }>): Promise<void> {
    for (const { userId, stats } of players) {
      await tx.playerStats.upsert({
        where: { userId_mode: { userId, mode } },
        create: { userId, mode, ...stats },
        update: {
          rounds: { increment: stats.rounds },
          kills: { increment: stats.kills },
          deaths: { increment: stats.deaths },
          assists: { increment: stats.assists },
          headshots: { increment: stats.headshots },
          damage: { increment: stats.damage },
          mvps: { increment: stats.mvps },
          flashAssists: { increment: stats.flashAssists },
          utilityDamage: { increment: stats.utilityDamage },
          clutches: { increment: stats.clutches },
          entryKills: { increment: stats.entryKills },
          entryDeaths: { increment: stats.entryDeaths },
        },
      });
    }
  }
}
