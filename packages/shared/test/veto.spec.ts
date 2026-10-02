import { describe, expect, it } from 'vitest';
import {
  applyVetoAction,
  buildDefaultVetoSteps,
  chooseAutoAction,
  createVetoState,
  currentStep,
  finaliseVeto,
  isVetoComplete,
  remainingMaps,
  validateVetoSteps,
  type BestOf,
  type VetoInput,
  type VetoState,
} from '../src/index.js';

const MAPS = ['mirage', 'inferno', 'nuke', 'ancient', 'anubis', 'overpass', 'dust2'];

function mustApply(state: VetoState, input: VetoInput): VetoState {
  const result = applyVetoAction(state, input);
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  return result.state;
}

/** Plays out a veto, always choosing the first remaining map and CT. */
function playOut(state: VetoState): VetoState {
  let current = state;
  for (let guard = 0; guard < 50 && !isVetoComplete(current); guard++) {
    const step = currentStep(current)!;
    if (step.action === 'SIDE') current = mustApply(current, { team: step.team!, action: 'SIDE', side: 'CT' });
    else current = mustApply(current, { team: step.team!, action: step.action as 'BAN' | 'PICK', mapId: remainingMaps(current)[0]! });
  }
  return current;
}

describe('default veto templates', () => {
  it.each<[BestOf, number]>([
    [1, 7], [1, 8], [3, 7], [3, 8], [3, 5], [3, 3], [5, 7], [5, 8], [5, 5],
  ])('best-of-%i with %i maps is valid', (bestOf, mapCount) => {
    const steps = buildDefaultVetoSteps(bestOf, mapCount);
    expect(validateVetoSteps(steps, bestOf, mapCount)).toEqual([]);
  });

  it('matches the documented BO3 order for 7 maps', () => {
    const steps = buildDefaultVetoSteps(3, 7).filter((s) => s.action !== 'SIDE');
    expect(steps.map((s) => `${s.action}${s.team ?? ''}`)).toEqual([
      'BANA', 'BANB', 'PICKA', 'PICKB', 'BANA', 'BANB', 'DECIDER',
    ]);
  });

  it('matches the BO1 order: alternating bans then decider', () => {
    const steps = buildDefaultVetoSteps(1, 7).filter((s) => s.action !== 'SIDE');
    expect(steps.map((s) => `${s.action}${s.team ?? ''}`)).toEqual([
      'BANA', 'BANB', 'BANA', 'BANB', 'BANA', 'BANB', 'DECIDER',
    ]);
  });

  it('lets the opponent choose the side after each pick', () => {
    const steps = buildDefaultVetoSteps(3, 7);
    const pickIndex = steps.findIndex((s) => s.action === 'PICK');
    expect(steps[pickIndex]!.team).toBe('A');
    expect(steps[pickIndex + 1]).toEqual({ action: 'SIDE', team: 'B' });
  });

  it('rejects pools that are too small', () => {
    expect(() => buildDefaultVetoSteps(3, 2)).toThrow(/at least/);
    expect(() => buildDefaultVetoSteps(5, 4)).toThrow(/at least/);
  });
});

describe('validateVetoSteps', () => {
  it('reports structural errors', () => {
    expect(validateVetoSteps([{ action: 'BAN', team: 'A' }], 1, 7).length).toBeGreaterThan(0);
    expect(validateVetoSteps([{ action: 'DECIDER' }, { action: 'DECIDER' }], 1, 2).join()).toMatch(/Exactly one DECIDER/);
    expect(validateVetoSteps([{ action: 'SIDE', team: 'A' }, { action: 'DECIDER' }], 1, 1).join()).toMatch(/SIDE must directly follow/);
    expect(validateVetoSteps([{ action: 'BAN' }, { action: 'DECIDER' }], 1, 2).join()).toMatch(/needs team/);
  });

  it('requires the step count to consume the whole pool', () => {
    const steps = buildDefaultVetoSteps(1, 7);
    expect(validateVetoSteps(steps, 1, 8).join()).toMatch(/pool has 8/);
  });
});

describe('veto flow', () => {
  const bo3 = buildDefaultVetoSteps(3, 7);

  it('starts with the team that was drawn', () => {
    expect(currentStep(createVetoState(MAPS, bo3, 'B'))!.team).toBe('B');
    expect(currentStep(createVetoState(MAPS, bo3, 'A'))!.team).toBe('A');
  });

  it('enforces turn order', () => {
    const state = createVetoState(MAPS, bo3, 'A');
    const result = applyVetoAction(state, { team: 'B', action: 'BAN', mapId: 'mirage' });
    expect(result).toMatchObject({ ok: false, error: 'NOT_YOUR_TURN' });
  });

  it('enforces the expected action type', () => {
    const state = createVetoState(MAPS, bo3, 'A');
    expect(applyVetoAction(state, { team: 'A', action: 'PICK', mapId: 'mirage' })).toMatchObject({ error: 'WRONG_ACTION' });
  });

  it('does not allow banned or unknown maps', () => {
    let state = createVetoState(MAPS, bo3, 'A');
    state = mustApply(state, { team: 'A', action: 'BAN', mapId: 'mirage' });
    expect(applyVetoAction(state, { team: 'B', action: 'BAN', mapId: 'mirage' })).toMatchObject({ error: 'MAP_NOT_AVAILABLE' });
    expect(applyVetoAction(state, { team: 'B', action: 'BAN', mapId: 'cobblestone' })).toMatchObject({ error: 'MAP_NOT_AVAILABLE' });
    expect(applyVetoAction(state, { team: 'B', action: 'BAN' })).toMatchObject({ error: 'MAP_REQUIRED' });
  });

  it('requires a valid side choice', () => {
    let state = createVetoState(MAPS, bo3, 'A');
    state = mustApply(state, { team: 'A', action: 'BAN', mapId: 'mirage' });
    state = mustApply(state, { team: 'B', action: 'BAN', mapId: 'inferno' });
    state = mustApply(state, { team: 'A', action: 'PICK', mapId: 'nuke' });
    expect(currentStep(state)).toMatchObject({ action: 'SIDE', team: 'B' });
    expect(applyVetoAction(state, { team: 'B', action: 'SIDE' })).toMatchObject({ error: 'SIDE_REQUIRED' });
    expect(applyVetoAction(state, { team: 'A', action: 'SIDE', side: 'CT' })).toMatchObject({ error: 'NOT_YOUR_TURN' });
  });

  it('assigns the decider automatically and finishes', () => {
    const done = playOut(createVetoState(MAPS, bo3, 'A'));
    expect(isVetoComplete(done)).toBe(true);
    const decider = done.records.find((r) => r.action === 'DECIDER')!;
    expect(decider.auto).toBe(true);
    expect(decider.team).toBeNull();
    expect(remainingMaps(done)).toEqual([]);
    expect(applyVetoAction(done, { team: 'A', action: 'BAN', mapId: 'x' })).toMatchObject({ error: 'VETO_COMPLETE' });
  });

  it('plays BO1 with a single decider map', () => {
    const done = playOut(createVetoState(MAPS, buildDefaultVetoSteps(1, 7), 'A'));
    const series = finaliseVeto(done);
    expect(series).toHaveLength(1);
    expect(series[0]!.pickedBy).toBeNull();
  });

  it('orders the series: picks in pick order, decider last, with side per map', () => {
    let state = createVetoState(MAPS, bo3, 'B'); // team B plays template "A"
    state = mustApply(state, { team: 'B', action: 'BAN', mapId: 'mirage' });
    state = mustApply(state, { team: 'A', action: 'BAN', mapId: 'inferno' });
    state = mustApply(state, { team: 'B', action: 'PICK', mapId: 'nuke' });
    state = mustApply(state, { team: 'A', action: 'SIDE', side: 'T' }); // A chooses T on nuke → B is CT
    state = mustApply(state, { team: 'A', action: 'PICK', mapId: 'ancient' });
    state = mustApply(state, { team: 'B', action: 'SIDE', side: 'CT' }); // B chooses CT on ancient → A is T
    state = mustApply(state, { team: 'B', action: 'BAN', mapId: 'anubis' });
    state = mustApply(state, { team: 'A', action: 'BAN', mapId: 'overpass' });
    expect(isVetoComplete(state)).toBe(false); // decider side still open
    // last ban was by template-B = slot A → decider side chosen by template-A = slot B
    expect(currentStep(state)).toMatchObject({ action: 'SIDE', team: 'B' });
    state = mustApply(state, { team: 'B', action: 'SIDE', side: 'T' });
    expect(isVetoComplete(state)).toBe(true);

    const series = finaliseVeto(state);
    expect(series.map((s) => s.mapId)).toEqual(['nuke', 'ancient', 'dust2']);
    expect(series.map((s) => s.pickedBy)).toEqual(['B', 'A', null]);
    // Team A's starting side per map.
    expect(series.map((s) => s.teamAStartSide)).toEqual(['T', 'T', 'CT']);
    expect(series.map((s) => s.mapNumber)).toEqual([1, 2, 3]);
  });

  it('auto actions complete a veto when both teams time out', () => {
    let state = createVetoState(MAPS, buildDefaultVetoSteps(5, 7), 'A');
    let rng = 0.3;
    for (let i = 0; i < 40 && !isVetoComplete(state); i++) {
      const auto = chooseAutoAction(state, () => (rng = (rng * 7.13) % 1));
      expect(auto).not.toBeNull();
      expect(auto!.auto).toBe(true);
      state = mustApply(state, auto!);
    }
    expect(isVetoComplete(state)).toBe(true);
    expect(finaliseVeto(state)).toHaveLength(5);
    expect(new Set(finaliseVeto(state).map((s) => s.mapId)).size).toBe(5);
  });

  it('finalising an unfinished veto fails', () => {
    expect(() => finaliseVeto(createVetoState(MAPS, bo3, 'A'))).toThrow(/not complete/);
  });

  it('supports configurable custom orders', () => {
    const custom = [
      { action: 'BAN', team: 'B' },
      { action: 'BAN', team: 'B' },
      { action: 'BAN', team: 'A' },
      { action: 'PICK', team: 'A' },
      { action: 'BAN', team: 'B' },
      { action: 'BAN', team: 'A' },
      { action: 'BAN', team: 'B' },
      { action: 'DECIDER' },
    ] as const;
    const errors = validateVetoSteps(custom, 3, 8);
    expect(errors.join()).toMatch(/best-of-3 needs 2 picks/);
    const bo1custom = [
      { action: 'BAN', team: 'B' },
      { action: 'BAN', team: 'B' },
      { action: 'DECIDER' },
    ] as const;
    expect(validateVetoSteps(bo1custom, 1, 3)).toEqual([]);
    const state = createVetoState(['a', 'b', 'c'], bo1custom, 'A');
    expect(currentStep(state)!.team).toBe('B');
  });
});
