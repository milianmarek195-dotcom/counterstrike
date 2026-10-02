import { Injectable } from '@nestjs/common';
import type { GameMode, MatchKind, TeamSlot, TransactionClient } from '@celtist/database';
import { DEFAULT_TEAM_SIZE, MAX_TEAM_SIZE, type BestOf } from '@celtist/shared';
import { badRequest } from '../../common/errors.js';

export interface MatchPlayerSpec {
  userId: string;
  isCaptain?: boolean;
  isSubstitute?: boolean;
}

export interface MatchTeamSpec {
  slot: TeamSlot;
  name: string;
  /** Roster size of THIS side. Sides are independent: 2v3, 1v1, 4v5 … */
  maxPlayers?: number;
  teamId?: string | null;
  tournamentTeamId?: string | null;
  players: MatchPlayerSpec[];
}

export interface CreateMatchSpec {
  kind: MatchKind;
  mode: GameMode;
  bestOf: BestOf;
  mapPoolId: string | null;
  vetoTemplateId?: string | null;
  scheduledAt?: Date | null;
  status?: 'SCHEDULED' | 'WAITING';
  createdById?: string | null;
  /** Party leader steering the match together with the admins. */
  controllerId?: string | null;
  teams?: MatchTeamSpec[];
  /** Players in the lobby that are not on a team yet. */
  unassignedUserIds?: string[];
}

/**
 * Creates match rows with their teams and rosters. Used by tournaments (bracket nodes), party matches and admin-created
 * custom matches, so rosters are always built the same way. The factory is generic: it knows "Team A" and "Team B"
 * with their own player lists and never assumes a team size.
 */
@Injectable()
export class MatchFactory {
  async create(tx: TransactionClient, spec: CreateMatchSpec): Promise<{ id: string }> {
    const match = await tx.match.create({
      data: {
        kind: spec.kind,
        mode: spec.mode,
        status: spec.status ?? 'SCHEDULED',
        bestOf: spec.bestOf,
        mapPoolId: spec.mapPoolId,
        vetoTemplateId: spec.vetoTemplateId ?? null,
        scheduledAt: spec.scheduledAt ?? null,
        createdById: spec.createdById ?? null,
        controllerId: spec.controllerId ?? null,
      },
      select: { id: true },
    });
    for (const team of spec.teams ?? []) await this.addTeam(tx, match.id, spec.mode, team);
    if (spec.unassignedUserIds?.length) await this.addUnassigned(tx, match.id, spec.mode, spec.unassignedUserIds);
    return match;
  }

  async addTeam(tx: TransactionClient, matchId: string, mode: GameMode, team: MatchTeamSpec): Promise<void> {
    const maxPlayers = team.maxPlayers ?? DEFAULT_TEAM_SIZE;
    if (maxPlayers < 1 || maxPlayers > MAX_TEAM_SIZE) throw badRequest('INVALID_TEAM_SIZE', `A team has between 1 and ${MAX_TEAM_SIZE} players`);
    const userIds = team.players.map((p) => p.userId);
    if (new Set(userIds).size !== userIds.length) throw badRequest('DUPLICATE_PLAYER', 'A player is listed twice in a team');
    const starters = team.players.filter((p) => !p.isSubstitute);
    if (starters.length > maxPlayers) throw badRequest('TEAM_FULL', `Team "${team.name}" allows ${maxPlayers} players`);

    const { steamIds, averageElo } = await this.lookup(tx, mode, userIds, starters.map((p) => p.userId));
    const matchTeam = await tx.matchTeam.create({
      data: {
        matchId,
        slot: team.slot,
        name: team.name,
        maxPlayers,
        teamId: team.teamId ?? null,
        tournamentTeamId: team.tournamentTeamId ?? null,
        averageElo,
      },
    });
    if (team.players.length === 0) return;

    // Exactly one captain per non-empty team: the flagged player, otherwise the first starter.
    const captainId = starters.find((p) => p.isCaptain)?.userId ?? starters[0]?.userId;
    await tx.matchPlayer.createMany({
      data: team.players.map((p) => ({
        matchId,
        matchTeamId: matchTeam.id,
        userId: p.userId,
        steamId: steamIds.get(p.userId)!,
        mode,
        isSubstitute: p.isSubstitute ?? false,
        isCaptain: p.userId === captainId,
      })),
    });
  }

  async addUnassigned(tx: TransactionClient, matchId: string, mode: GameMode, userIds: string[]): Promise<void> {
    const { steamIds } = await this.lookup(tx, mode, userIds, []);
    await tx.matchPlayer.createMany({
      data: userIds.map((userId) => ({ matchId, matchTeamId: null, userId, steamId: steamIds.get(userId)!, mode })),
      skipDuplicates: true,
    });
  }

  private async lookup(tx: TransactionClient, mode: GameMode, userIds: string[], starterIds: string[]) {
    const [users, ranks] = await Promise.all([
      tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, steamId: true } }),
      tx.playerRank.findMany({ where: { userId: { in: starterIds }, mode }, select: { userId: true, elo: true } }),
    ]);
    if (users.length !== new Set(userIds).size) throw badRequest('UNKNOWN_PLAYER', 'A player does not exist');
    const elo = new Map(ranks.map((r) => [r.userId, r.elo] as const));
    const averageElo = starterIds.length ? Math.round(starterIds.reduce((sum, id) => sum + (elo.get(id) ?? 1000), 0) / starterIds.length) : 1000;
    return { steamIds: new Map(users.map((u) => [u.id, u.steamId] as const)), averageElo };
  }

  /** Recomputes a team's displayed average Elo after its roster changed. */
  async refreshAverageElo(tx: TransactionClient, matchTeamId: string, mode: GameMode): Promise<void> {
    const players = await tx.matchPlayer.findMany({ where: { matchTeamId, removedAt: null, isSubstitute: false }, select: { userId: true } });
    const ranks = await tx.playerRank.findMany({ where: { mode, userId: { in: players.map((p) => p.userId) } } });
    const total = players.reduce((sum, p) => sum + (ranks.find((r) => r.userId === p.userId)?.elo ?? 1000), 0);
    await tx.matchTeam.update({ where: { id: matchTeamId }, data: { averageElo: players.length ? Math.round(total / players.length) : 1000 } });
  }
}
