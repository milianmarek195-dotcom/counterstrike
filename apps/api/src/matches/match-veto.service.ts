import { randomInt } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '@celtist/database';
import {
  applyVetoAction,
  chooseAutoAction,
  createVetoState,
  currentStep,
  finaliseVeto,
  isVetoComplete,
  remainingMaps,
  type StartingSide,
  type TeamSlot,
  type VetoActionType,
  type VetoRecord,
  type VetoState,
  type VetoTemplateStep,
} from '@celtist/shared';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload } from '../common/domain-events.js';
import { badRequest, conflict, forbidden, notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { MatchCommandService } from './match-commands.service.js';
import { MatchConfigService } from './match-config.service.js';

export interface VetoActInput {
  action: Exclude<VetoActionType, 'DECIDER'>;
  mapId?: string;
  side?: StartingSide;
}

interface StoredVetoConfig {
  maps: string[];
  steps: VetoTemplateStep[];
}

@Injectable()
export class MatchVetoService {
  private readonly logger = new Logger(MatchVetoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly commands: MatchCommandService,
    private readonly config: MatchConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * A veto action. The match controller (party leader or admin) may decide for whichever team is on turn; otherwise only
   * the captain of the acting team can act.
   */
  async act(matchId: string, userId: string, input: VetoActInput, asController = false): Promise<void> {
    const loaded = await this.load(matchId);
    const step = currentStep(loaded.state);
    if (!step || step.team === null) throw conflict('VETO_NOT_ACTIVE', 'There is nothing to decide right now');

    if (!asController) {
      const player = await this.prisma.matchPlayer.findUnique({ where: { matchId_userId: { matchId, userId } }, include: { matchTeam: { select: { slot: true } } } });
      if (!player || player.removedAt || !player.matchTeam) throw notFound('NOT_IN_MATCH', 'You are not part of this match');
      if (player.matchTeam.slot !== step.team) throw forbidden(`It is team ${step.team}'s turn`, 'NOT_YOUR_TURN');
      if (!player.isCaptain) throw forbidden('Only the team captain can veto', 'NOT_CAPTAIN');
    }
    await this.apply(matchId, loaded, { team: step.team, ...input }, userId);
  }

  /** Skips the veto: every remaining step is decided at random (marked as automatic) and the match moves on. */
  async skip(matchId: string): Promise<void> {
    for (let guard = 0; guard < 60; guard++) {
      const loaded = await this.load(matchId);
      if (isVetoComplete(loaded.state)) return;
      const auto = chooseAutoAction(loaded.state, () => randomInt(0, 1_000_000) / 1_000_000);
      if (!auto) return;
      await this.apply(matchId, loaded, auto, null);
    }
  }

  /** Called by the job tick: teams that let the clock run out get a random legal choice. */
  async processTimeouts(): Promise<number> {
    const overdue = await this.prisma.match.findMany({
      where: { status: 'VETO', vetoDeadline: { lt: this.clock.now() } },
      select: { id: true },
    });
    let acted = 0;
    for (const { id } of overdue) {
      try {
        const loaded = await this.load(id);
        const auto = chooseAutoAction(loaded.state, () => randomInt(0, 1_000_000) / 1_000_000);
        if (!auto) continue;
        await this.apply(id, loaded, auto, null);
        acted++;
      } catch (error) {
        // Another actor (the team itself) may have acted in the meantime: not an error.
        if (!(error instanceof Error) || !/VETO_STEP_TAKEN|VETO_NOT_ACTIVE/.test(JSON.stringify((error as { response?: unknown }).response ?? error.message))) {
          this.logger.warn(`Auto veto failed for ${id}: ${(error as Error).message}`);
        }
      }
    }
    return acted;
  }

  async view(matchId: string) {
    const loaded = await this.load(matchId);
    const step = currentStep(loaded.state);
    const maps = await this.prisma.gameMap.findMany({ where: { id: { in: loaded.state.maps as string[] } } });
    const byId = new Map(maps.map((m) => [m.id, m] as const));
    return {
      startsWith: loaded.state.startsWith,
      deadline: loaded.deadline,
      complete: isVetoComplete(loaded.state),
      current: step ? { stepIndex: step.index, action: step.action, team: step.team } : null,
      remaining: remainingMaps(loaded.state).map((id) => ({ id, name: byId.get(id)?.name ?? id, key: byId.get(id)?.key ?? '' })),
      steps: loaded.state.steps.map((s, index) => ({ index, action: s.action, team: s.team === undefined ? null : s.team === 'A' ? loaded.state.startsWith : otherOf(loaded.state.startsWith) })),
      actions: loaded.state.records.map((r) => ({
        stepIndex: r.stepIndex,
        team: r.team,
        action: r.action,
        side: r.side,
        auto: r.auto,
        map: byId.get(r.mapId) ? { id: r.mapId, name: byId.get(r.mapId)!.name, key: byId.get(r.mapId)!.key } : null,
      })),
    };
  }

  // ─────────────── internals ───────────────

  private async load(matchId: string): Promise<{ state: VetoState; mode: 'FIVE_V_FIVE' | 'WINGMAN'; bestOf: number; deadline: Date | null }> {
    const match = await this.prisma.match.findUnique({ where: { id: matchId }, include: { vetoActions: { orderBy: { stepIndex: 'asc' } } } });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');
    if (match.status !== 'VETO' && match.status !== 'CONFIGURING' && match.status !== 'LIVE' && match.status !== 'FINISHED') {
      throw conflict('VETO_NOT_ACTIVE', 'The map veto has not started');
    }
    const config = match.vetoConfig as StoredVetoConfig | null;
    if (!config || !match.vetoStartsWith) throw conflict('VETO_NOT_ACTIVE', 'The map veto has not started');

    const records: VetoRecord[] = match.vetoActions.map((a) => ({
      stepIndex: a.stepIndex,
      team: a.team,
      action: a.action,
      mapId: a.mapId,
      side: a.side,
      auto: a.auto,
    }));
    const base = createVetoState(config.maps, config.steps, match.vetoStartsWith);
    // Replaying stored records through the engine would repeat validation; they were validated when written.
    const state: VetoState = { ...base, records };
    if (match.status !== 'VETO') return { state, mode: match.mode, bestOf: match.bestOf, deadline: null };
    return { state, mode: match.mode, bestOf: match.bestOf, deadline: match.vetoDeadline };
  }

  private async apply(
    matchId: string,
    loaded: { state: VetoState; mode: string },
    input: { team: TeamSlot; action: VetoActInput['action']; mapId?: string; side?: StartingSide; auto?: boolean },
    userId: string | null,
  ): Promise<void> {
    const result = applyVetoAction(loaded.state, input);
    if (!result.ok) {
      const status = result.error === 'VETO_COMPLETE' ? conflict : badRequest;
      throw status(`VETO_${result.error}`, result.message);
    }
    const fresh = result.state.records.slice(loaded.state.records.length);
    const complete = isVetoComplete(result.state);
    const stepTimeout = await this.settings.get('veto.stepTimeoutSeconds');

    try {
      await this.prisma.transact(async (tx) => {
        const guard = await tx.match.updateMany({ where: { id: matchId, status: 'VETO' }, data: { vetoDeadline: complete ? null : new Date(this.clock.nowMs() + stepTimeout * 1000) } });
        if (guard.count === 0) throw conflict('VETO_NOT_ACTIVE', 'The map veto is no longer active');
        await tx.matchVetoAction.createMany({
          data: fresh.map((r) => ({
            matchId,
            stepIndex: r.stepIndex,
            team: r.team,
            action: r.action,
            mapId: r.mapId,
            side: r.side,
            auto: r.auto,
            actedByUserId: r.action === 'DECIDER' ? null : userId,
          })),
        });
        if (complete) await this.complete(tx, matchId, result.state);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('VETO_STEP_TAKEN', 'This step was already decided');
      throw error;
    }

    this.events.emit(DomainEvent.MatchVeto, { matchId } satisfies MatchEventPayload);
    this.events.emit(DomainEvent.MatchUpdated, { matchId } satisfies MatchEventPayload);
    if (complete) {
      const match = await this.prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { serverId: true } });
      if (match.serverId) {
        const config = await this.config.build(matchId);
        await this.commands.issue({ serverId: match.serverId, matchId, type: 'MATCH_START', payload: { config }, idempotencyKey: `start:${matchId}` });
      }
    }
  }

  /** Veto finished: the maps of the series are fixed and the server is told to configure itself. */
  private async complete(tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], matchId: string, state: VetoState): Promise<void> {
    const series = finaliseVeto(state);
    await tx.matchMap.createMany({
      data: series.map((m) => ({ matchId, mapNumber: m.mapNumber, mapId: m.mapId, pickedBy: m.pickedBy, teamAStartSide: m.teamAStartSide })),
    });
    const moved = await tx.match.updateMany({ where: { id: matchId, status: 'VETO' }, data: { status: 'CONFIGURING', vetoDeadline: null } });
    if (moved.count === 0) throw conflict('VETO_NOT_ACTIVE', 'The map veto is no longer active');
  }
}

function otherOf(slot: TeamSlot): TeamSlot {
  return slot === 'A' ? 'B' : 'A';
}

