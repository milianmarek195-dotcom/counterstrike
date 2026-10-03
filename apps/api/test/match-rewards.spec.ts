import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MatchRewardsService } from '../src/skins/match-rewards.service.js';
import { SettingsService } from '../src/settings/settings.service.js';
import { SkinPermissionsService } from '../src/skins/skin-permissions.service.js';
import { createUser } from './support/auth.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('top fragger reward', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function finishedMatch(kind: 'TOURNAMENT' | 'CUSTOM' = 'TOURNAMENT') {
    const match = await t.prisma.match.create({
      data: { kind, mode: 'FIVE_V_FIVE', status: 'FINISHED', bestOf: 1, winnerSlot: 'A', teams: { create: [{ slot: 'A', name: 'A' }, { slot: 'B', name: 'B' }] } },
      include: { teams: true },
    });
    const a = match.teams.find((x) => x.slot === 'A')!;
    const b = match.teams.find((x) => x.slot === 'B')!;
    const winners = [];
    const kills = [30, 22, 18, 5, 0];
    for (const [i, k] of kills.entries()) {
      const u = await createUser(t, { displayName: `W${i}` });
      winners.push(u);
      await t.prisma.matchPlayer.create({ data: { matchId: match.id, matchTeamId: a.id, userId: u.id, steamId: u.steamId, mode: 'FIVE_V_FIVE', kills: k } });
    }
    const loser = await createUser(t, { displayName: 'L' });
    await t.prisma.matchPlayer.create({ data: { matchId: match.id, matchTeamId: b.id, userId: loser.id, steamId: loser.steamId, mode: 'FIVE_V_FIVE', kills: 99 } });
    return { match, winners, loser };
  }
  const enable = () => t.app.get(SettingsService).set('match.topFraggerReward', { enabled: true, topN: 3, level: 3, days: 7, tournamentsOnly: true }, null);

  it('does nothing while disabled', async () => {
    const { match } = await finishedMatch();
    expect(await t.app.get(MatchRewardsService).reward(match.id)).toEqual([]);
  });

  it('gives level 3 for 7 days to the three best fraggers of the winning team only, once', async () => {
    const { match, winners, loser } = await finishedMatch();
    await enable();
    const rewarded = await t.app.get(MatchRewardsService).reward(match.id);
    expect(rewarded).toEqual(winners.slice(0, 3).map((w) => w.id));
    const perms = t.app.get(SkinPermissionsService);
    const eff = await perms.effectiveFor(winners[0]!.id);
    expect(eff.level).toBe(3);
    expect(eff.expiresAt!.getTime() - t.clock.nowMs()).toBe(7 * 86_400_000);
    expect((await perms.effectiveFor(winners[3]!.id)).level).toBe(0);
    expect((await perms.effectiveFor(loser.id)).level).toBe(0);
    expect(await t.app.get(MatchRewardsService).reward(match.id)).toEqual([]);
  });

  it('skips party matches while tournamentsOnly is set', async () => {
    const { match } = await finishedMatch('CUSTOM');
    await enable();
    expect(await t.app.get(MatchRewardsService).reward(match.id)).toEqual([]);
  });
});
