import { Injectable } from '@nestjs/common';
import type { Tournament, TransactionClient } from '@celtist/database';
import {
  DEFAULT_BRACKET_OPTIONS,
  applyResult,
  computePlacements,
  createInitialState,
  getBracketGenerator,
  stateFromSnapshot,
  type BestOf,
  type BracketNode,
  type BracketOptions,
  type GeneratedBracket,
  type ProgressionEvents,
  type Slot,
} from '@celtist/shared';
import { MatchFactory, type MatchTeamSpec } from '../matches/core/match-factory.service.js';

type TeamWithMembers = {
  id: string;
  teamId: string | null;
  name: string;
  seed: number | null;
  members: Array<{ userId: string; role: 'CAPTAIN' | 'MEMBER' | 'SUBSTITUTE' }>;
};

export interface ProgressionOutcome {
  /** Matches that now have both teams and should be scheduled. */
  readyMatchIds: string[];
  championTournamentTeamId: string | null;
}

interface TournamentSettings {
  grandFinalReset?: boolean;
  thirdPlaceMatch?: boolean;
  bracket?: GeneratedBracket;
}

export function bracketOptionsFor(tournament: Pick<Tournament, 'grandFinalReset' | 'settings'>): BracketOptions {
  const settings = (tournament.settings ?? {}) as TournamentSettings;
  return {
    ...DEFAULT_BRACKET_OPTIONS,
    grandFinalReset: tournament.grandFinalReset,
    thirdPlaceMatch: settings.thirdPlaceMatch ?? false,
  };
}

/**
 * Bridges the pure bracket engine (packages/shared) and the database: creates the bracket rows when a tournament
 * starts and moves winners/losers on whenever a match finishes. Always runs inside the caller's transaction,
 * so a result, the Elo change and the bracket update commit together.
 *
 * The generated bracket is stored with the tournament when it starts, so a later change of the generator code can
 * never alter the shape of a tournament that is already running.
 */
@Injectable()
export class BracketProgressionService {
  constructor(private readonly factory: MatchFactory) {}

  /** Creates all bracket rows and returns the matches that are playable from the start. */
  async build(tx: TransactionClient, tournament: Tournament, teams: readonly TeamWithMembers[]): Promise<ProgressionOutcome> {
    const generator = getBracketGenerator(tournament.format);
    const bracket = generator.generate(
      teams.map((t) => ({ id: t.id, seed: t.seed ?? Number.MAX_SAFE_INTEGER })),
      bracketOptionsFor(tournament),
    );

    const idByKey = new Map<string, string>();
    for (const node of bracket.nodes) {
      let matchId: string | null = null;
      if (!node.isBye) {
        const match = await this.factory.create(tx, {
          kind: 'TOURNAMENT',
          mode: tournament.mode,
          bestOf: this.bestOfFor(tournament, bracket, node),
          mapPoolId: tournament.mapPoolId,
          vetoTemplateId: tournament.vetoTemplateId,
          // Started by an admin: playable as soon as both teams and a server are available.
          scheduledAt: null,
          createdById: tournament.createdById,
          status: 'SCHEDULED',
        });
        matchId = match.id;
      }
      const row = await tx.tournamentMatch.create({
        data: {
          tournamentId: tournament.id,
          matchId,
          key: node.key,
          side: node.side,
          round: node.round,
          position: node.position,
          label: node.label,
          isBye: node.isBye,
        },
      });
      idByKey.set(node.key, row.id);
    }
    for (const node of bracket.nodes) {
      if (!node.winnerNext && !node.loserNext) continue;
      await tx.tournamentMatch.update({
        where: { id: idByKey.get(node.key)! },
        data: {
          winnerNextId: node.winnerNext ? idByKey.get(node.winnerNext.nodeKey)! : null,
          winnerNextSlot: node.winnerNext?.slot ?? null,
          loserNextId: node.loserNext ? idByKey.get(node.loserNext.nodeKey)! : null,
          loserNextSlot: node.loserNext?.slot ?? null,
        },
      });
    }
    await tx.tournament.update({
      where: { id: tournament.id },
      data: { settings: { ...((tournament.settings ?? {}) as object), bracket } as never },
    });

    const { state, events } = createInitialState(bracket);
    const outcome = await this.persist(tx, tournament, bracket, events, new Map(teams.map((t) => [t.id, t] as const)));
    void state;
    return outcome;
  }

  /** Records the winner of a finished bracket match and advances the bracket. */
  async onMatchFinished(tx: TransactionClient, tournamentMatchId: string, winnerSlot: Slot): Promise<ProgressionOutcome> {
    const row = await tx.tournamentMatch.findUniqueOrThrow({ where: { id: tournamentMatchId }, include: { tournament: true } });
    const tournament = row.tournament;
    const bracket = ((tournament.settings ?? {}) as TournamentSettings).bracket;
    if (!bracket) throw new Error(`Tournament ${tournament.id} has no stored bracket`);

    const rows = await tx.tournamentMatch.findMany({ where: { tournamentId: tournament.id }, include: { match: { select: { status: true } } } });
    const state = stateFromSnapshot(
      bracket,
      rows.map((r) => ({
        key: r.key,
        teamA: r.teamAId,
        teamB: r.teamBId,
        winner: r.winnerId,
        done: r.winnerId !== null,
        cancelled: r.match?.status === 'CANCELLED',
      })),
    );
    const result = applyResult(bracket, state, row.key, winnerSlot);

    const winnerId = winnerSlot === 'A' ? row.teamAId : row.teamBId;
    await tx.tournamentMatch.update({ where: { id: row.id }, data: { winnerId } });

    const teams = await this.loadTeams(tx, tournament.id);
    const outcome = await this.persist(tx, tournament, bracket, result.events, teams);
    if (result.events.champion) {
      const placements = computePlacements(bracket, result.state);
      for (const [teamId, placement] of placements) await tx.tournamentTeam.update({ where: { id: teamId }, data: { placement } });
      await tx.tournament.update({ where: { id: tournament.id }, data: { status: 'FINISHED', finishedAt: new Date() } });
    }
    return outcome;
  }

  private async persist(
    tx: TransactionClient,
    tournament: Tournament,
    bracket: GeneratedBracket,
    events: ProgressionEvents,
    teams: ReadonlyMap<string, TeamWithMembers>,
  ): Promise<ProgressionOutcome> {
    const rows = await tx.tournamentMatch.findMany({ where: { tournamentId: tournament.id } });
    const byKey = new Map(rows.map((r) => [r.key, r] as const));
    void bracket;

    for (const placement of events.placements) {
      const row = byKey.get(placement.nodeKey)!;
      await tx.tournamentMatch.update({
        where: { id: row.id },
        data: placement.slot === 'A' ? { teamAId: placement.participantId } : { teamBId: placement.participantId },
      });
      if (row.matchId) {
        const team = teams.get(placement.participantId);
        if (!team) throw new Error(`Unknown tournament team ${placement.participantId}`);
        await this.factory.addTeam(tx, row.matchId, tournament.mode, { ...this.teamSpec(team, placement.slot), maxPlayers: tournament.teamSize });
      }
    }
    for (const resolved of events.autoResolved) {
      const row = byKey.get(resolved.nodeKey)!;
      await tx.tournamentMatch.update({ where: { id: row.id }, data: { winnerId: resolved.winnerId } });
    }
    for (const key of events.cancelled) {
      const row = byKey.get(key)!;
      if (row.matchId) {
        await tx.match.update({ where: { id: row.matchId }, data: { status: 'CANCELLED', cancelReason: 'GRAND_FINAL_RESET_NOT_REQUIRED' } });
      }
    }

    const readyMatchIds = events.ready.map((key) => byKey.get(key)?.matchId).filter((id): id is string => !!id);
    return { readyMatchIds, championTournamentTeamId: events.champion };
  }

  private async loadTeams(tx: TransactionClient, tournamentId: string): Promise<Map<string, TeamWithMembers>> {
    const teams = await tx.tournamentTeam.findMany({ where: { tournamentId }, include: { members: true } });
    return new Map(teams.map((t) => [t.id, t as TeamWithMembers] as const));
  }

  private teamSpec(team: TeamWithMembers, slot: Slot): MatchTeamSpec {
    return {
      slot,
      name: team.name,
      teamId: team.teamId,
      tournamentTeamId: team.id,
      players: team.members.map((m) => ({ userId: m.userId, isCaptain: m.role === 'CAPTAIN', isSubstitute: m.role === 'SUBSTITUTE' })),
    };
  }

  private bestOfFor(tournament: Tournament, bracket: GeneratedBracket, node: BracketNode): BestOf {
    const isFinal = node.key === bracket.finalKey || node.key === bracket.resetKey;
    return ((isFinal && tournament.bestOfFinal) || tournament.bestOf) as BestOf;
  }
}
