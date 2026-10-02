import request from 'supertest';
import { SIGNATURE_HEADERS, deriveServerKey, signRequest } from '@celtist/shared/signing';
import { MatchLifecycleService } from '../../src/matches/match-lifecycle.service.js';
import { ServerHeartbeatService } from '../../src/servers/server-heartbeat.service.js';
import { as, type TestUser } from './auth.js';
import type { TestApp } from './test-app.js';

const MASTER = 'm'.repeat(48);

/** Plays matches through the real HTTP surface (players via cookies, game server via signed requests). */
export class MatchDriver {
  private nonce = 0;

  constructor(
    private readonly t: TestApp,
    private readonly users: Map<string, TestUser>,
  ) {}

  async createServers(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const s = await this.t.prisma.server.create({
        data: { name: `drv-${i}`, ip: '10.1.0.1', port: 28000 + i, region: 'eu', status: 'READY', lastHeartbeatAt: this.t.clock.now() },
      });
      ids.push(s.id);
    }
    return ids;
  }

  /** Waits for the automation to pick the match up (it reacts to domain events asynchronously). */
  async untilStatus(matchId: string, status: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const m = await this.t.prisma.match.findUnique({ where: { id: matchId }, select: { status: true } });
      if (m?.status === status) return;
      if (Date.now() - start > timeoutMs) throw new Error(`Match ${matchId} is ${m?.status}, expected ${status}`);
      if (m?.status === 'WAITING') await this.t.app.get(MatchLifecycleService).tryAllocate(matchId);
      if (m?.status === 'LOBBY' && status === 'VETO') await this.t.app.get(MatchLifecycleService).startVeto(matchId).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Tournament matches go on automatically into the veto (no ready check); the captains veto, then a signed result for `winner`. */
  async play(matchId: string, winner: 'A' | 'B', rounds = { win: 13, lose: 9 }): Promise<void> {
    await this.untilStatus(matchId, 'VETO');
    const players = (await this.t.prisma.matchPlayer.findMany({ where: { matchId, removedAt: null, isSubstitute: false, matchTeamId: { not: null } }, include: { matchTeam: { select: { slot: true } } } })).map((p) => ({ ...p, matchTeam: p.matchTeam! }));

    for (let guard = 0; guard < 30; guard++) {
      const v = (await as(this.t, null).get(`/v1/matches/${matchId}/veto`).expect(200)).body;
      if (v.complete || !v.current) break;
      const actor = players.find((p) => p.matchTeam.slot === v.current.team && p.isCaptain)!;
      const body = v.current.action === 'SIDE' ? { action: 'SIDE', side: 'CT' } : { action: v.current.action, mapId: v.remaining[0].id };
      await as(this.t, this.users.get(actor.userId)!).post(`/v1/matches/${matchId}/veto`, body).expect(201);
    }

    const match = await this.t.prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { maps: { orderBy: { mapNumber: 'asc' } }, teams: { include: { players: true } } } });
    const total = rounds.win + rounds.lose;
    const needed = Math.ceil(match.bestOf / 2);
    for (const map of match.maps.slice(0, needed)) {
      const stats = (steamId: string, team: 'A' | 'B', kills: number) => ({ steamId, team, rounds: total, kills, deaths: 10, assists: 2, headshots: 2, damage: kills * 90, mvps: 2 });
      const payload = {
        matchId,
        mapNumber: map.mapNumber,
        idempotencyKey: `drv-${matchId}-${map.mapNumber}`,
        scoreA: winner === 'A' ? rounds.win : rounds.lose,
        scoreB: winner === 'B' ? rounds.win : rounds.lose,
        rounds: total,
        startedAt: new Date(this.t.clock.nowMs() - 40 * 60_000).toISOString(),
        endedAt: new Date(this.t.clock.nowMs() - 1000).toISOString(),
        players: match.teams.flatMap((team) => team.players.filter((p) => !p.isSubstitute).map((p) => stats(p.steamId, team.slot, team.slot === winner ? 15 : 8))),
      };
      await this.signedPost(match.serverId!, `/server/v1/matches/${matchId}/result`, payload).expect(200);
    }
    const done = await this.t.prisma.match.findUniqueOrThrow({ where: { id: matchId }, select: { status: true, serverId: true } });
    if (done.status !== 'FINISHED') throw new Error(`Match ${matchId} did not finish (${done.status})`);
    // the plugin reports "idle" again, freeing the server for the next match
    await this.t.app.get(ServerHeartbeatService).handle(done.serverId!, { status: 'READY', currentMatchId: null, players: 0, version: '1', timestampMs: this.t.clock.nowMs() });
  }

  signedPost(serverId: string, path: string, payload: object) {
    const body = JSON.stringify(payload);
    const timestampMs = this.t.clock.nowMs();
    const nonce = `drv${++this.nonce}x${Date.now()}`;
    return request(this.t.app.getHttpServer())
      .post(path)
      .set({
        [SIGNATURE_HEADERS.server]: serverId,
        [SIGNATURE_HEADERS.timestamp]: String(timestampMs),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.signature]: signRequest(deriveServerKey(MASTER, serverId, 1), { method: 'POST', pathWithQuery: path, timestampMs, nonce, body }),
      })
      .set('content-type', 'application/json')
      .send(body);
  }
}
