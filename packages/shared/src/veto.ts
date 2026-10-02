import { otherSlot, type BestOf, type StartingSide, type TeamSlot } from './constants.js';

/**
 * Map veto engine (pure). A template is an ordered list of steps; `team: 'A'` means "the team that starts
 * the veto", `'B'` the other team. Who starts is drawn once per match, so templates stay reusable.
 *
 * Step kinds
 *  BAN      acting team removes a map
 *  PICK     acting team selects a map to be played
 *  SIDE     acting team chooses its starting side on the map of the directly preceding PICK/DECIDER
 *  DECIDER  the single remaining map is added automatically (no team)
 */

export type VetoActionType = 'BAN' | 'PICK' | 'SIDE' | 'DECIDER';
export type TemplateTeam = 'A' | 'B';

export interface VetoTemplateStep {
  action: VetoActionType;
  /** Required for BAN, PICK, SIDE; absent for DECIDER. */
  team?: TemplateTeam;
}

export interface VetoRecord {
  stepIndex: number;
  /** Match slot that acted; null for the automatic decider. */
  team: TeamSlot | null;
  action: VetoActionType;
  mapId: string;
  /** Starting side chosen by the acting team (SIDE records only). */
  side: StartingSide | null;
  auto: boolean;
}

export interface VetoState {
  /** Snapshot of the map pool at veto start (ids). */
  maps: readonly string[];
  steps: readonly VetoTemplateStep[];
  /** Match slot that plays template team "A". */
  startsWith: TeamSlot;
  records: readonly VetoRecord[];
}

export type VetoErrorCode =
  | 'VETO_COMPLETE'
  | 'NOT_YOUR_TURN'
  | 'WRONG_ACTION'
  | 'MAP_REQUIRED'
  | 'MAP_NOT_AVAILABLE'
  | 'SIDE_REQUIRED'
  | 'INVALID_STATE';

export type VetoResult =
  | { ok: true; state: VetoState }
  | { ok: false; error: VetoErrorCode; message: string };

const fail = (error: VetoErrorCode, message: string): VetoResult => ({ ok: false, error, message });

// ───────────────────────── Templates ─────────────────────────

/** Structure only (independent of the map pool): used when an admin saves a template. */
export function validateVetoShape(steps: readonly VetoTemplateStep[], bestOf: BestOf): string[] {
  return validate(steps, bestOf, null);
}

/** Structure plus: the steps must consume exactly the maps of a pool of `mapCount` maps. */
export function validateVetoSteps(steps: readonly VetoTemplateStep[], bestOf: BestOf, mapCount: number): string[] {
  return validate(steps, bestOf, mapCount);
}

function validate(steps: readonly VetoTemplateStep[], bestOf: BestOf, mapCount: number | null): string[] {
  const errors: string[] = [];
  let bans = 0;
  let picks = 0;
  let deciders = 0;
  steps.forEach((step, index) => {
    if (step.action === 'DECIDER') {
      deciders++;
      if (step.team !== undefined) errors.push(`Step ${index + 1}: the decider has no team`);
    } else if (step.team !== 'A' && step.team !== 'B') {
      errors.push(`Step ${index + 1}: ${step.action} needs team A or B`);
    }
    if (step.action === 'BAN') bans++;
    if (step.action === 'PICK') picks++;
    if (step.action === 'SIDE') {
      const previous = steps[index - 1]?.action;
      if (previous !== 'PICK' && previous !== 'DECIDER') {
        errors.push(`Step ${index + 1}: SIDE must directly follow a PICK or the DECIDER`);
      }
    }
  });
  if (deciders !== 1) errors.push('Exactly one DECIDER step is required');
  else {
    const mapSteps = steps.filter((s) => s.action !== 'SIDE');
    if (mapSteps[mapSteps.length - 1]?.action !== 'DECIDER') errors.push('The DECIDER must be the last map step');
  }
  if (picks + 1 !== bestOf) errors.push(`A best-of-${bestOf} needs ${bestOf - 1} picks plus the decider (found ${picks})`);
  if (mapCount !== null && bans + picks + 1 !== mapCount) {
    errors.push(`The steps use ${bans + picks + 1} maps but the pool has ${mapCount}`);
  }
  return errors;
}

/**
 * Default veto order for a pool of `mapCount` maps.
 *  BO1: alternating bans, last map is the decider.
 *  BO3: Ban A, Ban B, Pick A, Pick B, then alternating bans, decider.
 *  BO5: Ban A, Ban B, Pick A, Pick B, Pick A, Pick B, then alternating bans, decider.
 * Every pick is followed by the opponent's side choice; the decider's side is chosen by the team that
 * did not make the last ban (team A if there were no bans).
 */
export function buildDefaultVetoSteps(bestOf: BestOf, mapCount: number): VetoTemplateStep[] {
  const pickCount = bestOf - 1;
  const minimumMaps = pickCount + 1;
  if (mapCount < minimumMaps) {
    throw new RangeError(`A best-of-${bestOf} needs at least ${minimumMaps} maps (pool has ${mapCount})`);
  }
  const steps: VetoTemplateStep[] = [];
  let banIndex = 0;
  const ban = (): void => {
    steps.push({ action: 'BAN', team: banIndex % 2 === 0 ? 'A' : 'B' });
    banIndex++;
  };

  if (bestOf === 1) {
    for (let i = 0; i < mapCount - 1; i++) ban();
  } else {
    const initialBans = Math.min(2, mapCount - minimumMaps);
    for (let i = 0; i < initialBans; i++) ban();
    for (let i = 0; i < pickCount; i++) {
      const team: TemplateTeam = i % 2 === 0 ? 'A' : 'B';
      steps.push({ action: 'PICK', team });
      steps.push({ action: 'SIDE', team: team === 'A' ? 'B' : 'A' });
    }
    banIndex = 0;
    const remainingBans = mapCount - initialBans - pickCount - 1;
    for (let i = 0; i < remainingBans; i++) ban();
  }
  const lastBan = [...steps].reverse().find((s) => s.action === 'BAN')?.team;
  steps.push({ action: 'DECIDER' });
  steps.push({ action: 'SIDE', team: lastBan === 'A' ? 'B' : 'A' });
  return steps;
}

// ───────────────────────── State ─────────────────────────

export function slotForStep(step: VetoTemplateStep, startsWith: TeamSlot): TeamSlot | null {
  if (step.team === undefined) return null;
  return step.team === 'A' ? startsWith : otherSlot(startsWith);
}

export function createVetoState(
  maps: readonly string[],
  steps: readonly VetoTemplateStep[],
  startsWith: TeamSlot,
): VetoState {
  return advanceAutomatic({ maps, steps, startsWith, records: [] });
}

const MAP_ACTIONS: readonly VetoActionType[] = ['BAN', 'PICK', 'DECIDER'];

export function usedMaps(state: VetoState): Set<string> {
  return new Set(state.records.filter((r) => MAP_ACTIONS.includes(r.action)).map((r) => r.mapId));
}

export function remainingMaps(state: VetoState): string[] {
  const used = usedMaps(state);
  return state.maps.filter((id) => !used.has(id));
}

export interface CurrentStep {
  index: number;
  action: VetoActionType;
  /** Match slot expected to act; null only for the decider (which resolves automatically). */
  team: TeamSlot | null;
}

export function currentStep(state: VetoState): CurrentStep | null {
  const index = state.records.length;
  const step = state.steps[index];
  if (!step) return null;
  return { index, action: step.action, team: slotForStep(step, state.startsWith) };
}

export function isVetoComplete(state: VetoState): boolean {
  return state.records.length >= state.steps.length;
}

/** Runs DECIDER steps (and nothing else) until a human decision is needed or the veto is over. */
function advanceAutomatic(state: VetoState): VetoState {
  let current = state;
  for (;;) {
    const step = currentStep(current);
    if (!step || step.action !== 'DECIDER') return current;
    const left = remainingMaps(current);
    if (left.length !== 1) {
      throw new RangeError(`The decider needs exactly one remaining map, found ${left.length}`);
    }
    current = {
      ...current,
      records: [
        ...current.records,
        { stepIndex: step.index, team: null, action: 'DECIDER', mapId: left[0]!, side: null, auto: true },
      ],
    };
  }
}

export interface VetoInput {
  team: TeamSlot;
  action: Exclude<VetoActionType, 'DECIDER'>;
  mapId?: string;
  side?: StartingSide;
  /** Set when the system acts because the time limit ran out. */
  auto?: boolean;
}

export function applyVetoAction(state: VetoState, input: VetoInput): VetoResult {
  const step = currentStep(state);
  if (!step) return fail('VETO_COMPLETE', 'The veto is already complete');
  if (step.action === 'DECIDER') return fail('INVALID_STATE', 'The decider resolves automatically');
  if (step.team !== input.team) return fail('NOT_YOUR_TURN', `It is team ${step.team}'s turn`);
  if (step.action !== input.action) return fail('WRONG_ACTION', `Expected ${step.action}, got ${input.action}`);

  let record: VetoRecord;
  if (step.action === 'SIDE') {
    if (input.side !== 'CT' && input.side !== 'T') return fail('SIDE_REQUIRED', 'Choose CT or T');
    const target = [...state.records].reverse().find((r) => r.action === 'PICK' || r.action === 'DECIDER');
    if (!target) return fail('INVALID_STATE', 'There is no map to choose a side for');
    record = { stepIndex: step.index, team: input.team, action: 'SIDE', mapId: target.mapId, side: input.side, auto: input.auto ?? false };
  } else {
    if (!input.mapId) return fail('MAP_REQUIRED', 'Choose a map');
    if (!remainingMaps(state).includes(input.mapId)) return fail('MAP_NOT_AVAILABLE', 'That map is not available');
    record = { stepIndex: step.index, team: input.team, action: step.action, mapId: input.mapId, side: null, auto: input.auto ?? false };
  }
  return { ok: true, state: advanceAutomatic({ ...state, records: [...state.records, record] }) };
}

/** What the system does when a team lets the clock run out: a random legal choice. */
export function chooseAutoAction(state: VetoState, random: () => number): VetoInput | null {
  const step = currentStep(state);
  if (!step || step.team === null || step.action === 'DECIDER') return null;
  if (step.action === 'SIDE') {
    return { team: step.team, action: 'SIDE', side: random() < 0.5 ? 'CT' : 'T', auto: true };
  }
  const left = remainingMaps(state);
  if (left.length === 0) return null;
  const mapId = left[Math.min(left.length - 1, Math.floor(random() * left.length))]!;
  return { team: step.team, action: step.action, mapId, auto: true };
}

export function pickStartingTeam(random: () => number): TeamSlot {
  return random() < 0.5 ? 'A' : 'B';
}

export interface SeriesMap {
  mapNumber: number;
  mapId: string;
  /** null for the decider */
  pickedBy: TeamSlot | null;
  teamAStartSide: StartingSide;
}

/** Maps in play order (picks in pick order, decider last) with Team A's starting side. */
export function finaliseVeto(state: VetoState): SeriesMap[] {
  if (!isVetoComplete(state)) throw new RangeError('The veto is not complete');
  const played = state.records.filter((r) => r.action === 'PICK' || r.action === 'DECIDER');
  return played.map((record, index) => {
    const sideRecord = state.records.find((r) => r.action === 'SIDE' && r.mapId === record.mapId);
    let teamAStartSide: StartingSide;
    if (sideRecord?.side && sideRecord.team) {
      const chosen = sideRecord.side;
      teamAStartSide = sideRecord.team === 'A' ? chosen : chosen === 'CT' ? 'T' : 'CT';
    } else {
      // Custom template without a side step: alternate so neither team always starts on the same side.
      teamAStartSide = index % 2 === 0 ? 'CT' : 'T';
    }
    return { mapNumber: index + 1, mapId: record.mapId, pickedBy: record.team, teamAStartSide };
  });
}
