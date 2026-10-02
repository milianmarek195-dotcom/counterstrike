import { randomUUID } from 'node:crypto';
import type { GatewayClient } from './client.js';

interface Command {
  id: string;
  type: string;
  matchId: string | null;
  payload: Record<string, unknown>;
}

interface ConfigPlayer {
  steamId: string;
  name: string;
}
interface MatchConfig {
  matchId: string;
  bestOf: number;
  teams: Record<'A' | 'B', { name: string; maxPlayers: number; players: ConfigPlayer[] } | null>;
  maps: Array<{ mapNumber: number; key: string }>;
  rules: { roundsToWin: number };
}

export interface SimulatorOptions {
  /** Milliseconds between simulated rounds (default 400). */
  roundMs?: number;
  /** Deterministic winner for tests: "A", "B" or undefined for random. */
  forceWinner?: 'A' | 'B';
  log?: (message: string) => void;
}

type Status = 'STARTING' | 'READY' | 'IN_USE' | 'ERROR';

/**
 * Behaves like a CS2 server running the plugin: heartbeats, long-polls commands, authorises joining players,
 * plays a match on MATCH_START and reports signed events and the final map result. No game is involved.
 */
export class MockCs2Server {
  private status: Status = 'STARTING';
  private currentMatchId: string | null = null;
  private config: MatchConfig | null = null;
  private seq = 0;
  private running = false;
  private paused = false;
  private playing: AbortController | null = null;
  private readonly startedAt = Date.now();
  readonly connected = new Set<string>();
  readonly denied: Array<{ steamId: string; reason: string }> = [];
  private readonly log: (m: string) => void;

  constructor(
    private readonly api: GatewayClient,
    private readonly options: SimulatorOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
  }

  get state() {
    return { status: this.status, matchId: this.currentMatchId, paused: this.paused };
  }

  async heartbeat(): Promise<void> {
    if (this.status === 'STARTING') this.status = 'READY';
    const res = await this.api.request('POST', '/server/v1/heartbeat', {
      status: this.status,
      currentMatchId: this.currentMatchId,
      players: this.connected.size,
      version: 'mock-1.0.0',
      timestampMs: Date.now(),
      health: { map: this.config?.maps[0]?.key ?? 'de_dust2', tickrate: 64, cpuLoad: 3, memoryMb: 512, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) },
    });
    if (res.status !== 200) this.log(`heartbeat rejected: ${res.status}`);
  }

  /** One long-poll round: fetch pending commands and execute them. Returns how many were handled. */
  async pollOnce(wait = 0): Promise<number> {
    const res = await this.api.request<{ commands: Command[] }>('GET', `/server/v1/commands?wait=${wait}`);
    if (res.status !== 200) return 0;
    for (const command of res.data.commands) {
      const outcome = await this.execute(command).catch((error: Error) => ({ ok: false, reason: error.message }));
      await this.api.request('POST', `/server/v1/commands/${command.id}/ack`, outcome.ok ? { status: 'ACKED' } : { status: 'FAILED', reason: outcome.reason?.slice(0, 280) });
    }
    return res.data.commands.length;
  }

  /** Runs heartbeat + command loops until stop() is called. */
  async run(): Promise<void> {
    this.running = true;
    const beat = (async () => {
      while (this.running) {
        await this.heartbeat().catch((e: Error) => this.log(`heartbeat failed: ${e.message}`));
        await new Promise((r) => setTimeout(r, 10_000));
      }
    })();
    while (this.running) {
      await this.pollOnce(25).catch(async (e: Error) => {
        this.log(`poll failed: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      });
    }
    await beat;
  }

  stop(): void {
    this.running = false;
    this.playing?.abort();
  }

  /** A player tries to join: the plugin asks the backend, which checks the assignment (ACCESS DENIED otherwise). */
  async playerJoins(steamId: string): Promise<boolean> {
    const res = await this.api.request<{ allowed: boolean; reason?: string }>('POST', '/server/v1/players/authorize', { steamId });
    if (res.status === 200 && res.data.allowed) {
      this.connected.add(steamId);
      await this.sendEvent({ type: 'player.connected', steamId });
      return true;
    }
    const reason = res.data?.reason ?? `HTTP ${res.status}`;
    this.denied.push({ steamId, reason });
    await this.sendEvent({ type: 'player.rejected', steamId, reason });
    return false;
  }

  async playerLeaves(steamId: string): Promise<void> {
    if (this.connected.delete(steamId)) await this.sendEvent({ type: 'player.disconnected', steamId });
  }

  private async execute(command: Command): Promise<{ ok: boolean; reason?: string }> {
    this.log(`command ${command.type}`);
    switch (command.type) {
      case 'MATCH_PREPARE': {
        const config = (command.payload.config ?? null) as MatchConfig | null;
        if (!config || !command.matchId) return { ok: false, reason: 'config missing' };
        this.config = config;
        this.currentMatchId = command.matchId;
        this.status = 'IN_USE';
        await this.sendEvent({ type: 'match.configured' });
        return { ok: true };
      }
      case 'MATCH_START':
      case 'MATCH_RESUME':
      case 'MATCH_RESTART':
        if (!this.currentMatchId) return { ok: false, reason: 'no match prepared' };
        if (command.payload.config) this.config = command.payload.config as MatchConfig;
        void this.playMatch();
        return { ok: true };
      case 'MATCH_PAUSE':
        this.paused = true;
        await this.sendEvent({ type: 'match.paused', team: null, reason: 'admin' });
        return { ok: true };
      case 'MATCH_UNPAUSE':
        this.paused = false;
        await this.sendEvent({ type: 'match.unpaused' });
        return { ok: true };
      case 'MATCH_CANCEL':
        this.playing?.abort();
        this.reset();
        return { ok: true };
      case 'MATCH_FORCE_TEAM':
      case 'MATCH_REMOVE_PLAYER':
      case 'MATCH_PARDON_PLAYER':
      case 'MATCH_SET_SCORE':
      case 'MATCH_CHANGE_MAP':
      case 'PLAYER_REFRESH_SKINS':
      case 'SERVER_RELOAD_CONFIG':
        return { ok: true };
      default:
        return { ok: false, reason: `unsupported command ${command.type}` };
    }
  }

  private reset(): void {
    this.currentMatchId = null;
    this.config = null;
    this.paused = false;
    this.connected.clear();
    this.status = 'READY';
  }

  /** Plays every map of the series round by round and posts the signed map result after each map. */
  private async playMatch(): Promise<void> {
    if (this.playing || !this.config || !this.currentMatchId) return;
    const config = this.config;
    const matchId = this.currentMatchId;
    const abort = (this.playing = new AbortController());
    const wins = { A: 0, B: 0 };
    const need = Math.ceil(config.bestOf / 2);
    try {
      for (const map of config.maps) {
        if (wins.A >= need || wins.B >= need) break;
        await this.sendEvent({ type: 'map.started', mapNumber: map.mapNumber });
        const toWin = config.rules.roundsToWin;
        const score = { A: 0, B: 0 };
        const winner = this.options.forceWinner ?? (Math.random() < 0.5 ? 'A' : 'B');
        while (score.A < toWin && score.B < toWin) {
          if (abort.signal.aborted) return;
          while (this.paused && !abort.signal.aborted) await new Promise((r) => setTimeout(r, 100));
          await new Promise((r) => setTimeout(r, this.options.roundMs ?? 400));
          // The designated winner takes ~65 % of the rounds but never overshoots the limit.
          const roundWinner = Math.random() < 0.65 ? winner : winner === 'A' ? 'B' : 'A';
          // The loser can never reach the round limit, so the designated winner always decides the map.
          if (roundWinner !== winner && score[roundWinner] + 1 >= toWin) continue;
          score[roundWinner]++;
          await this.sendEvent({ type: 'round.ended', mapNumber: map.mapNumber, scoreA: score.A, scoreB: score.B });
        }
        wins[score.A > score.B ? 'A' : 'B']++;
        const rounds = score.A + score.B;
        const players = (['A', 'B'] as const).flatMap((slot) =>
          (config.teams[slot]?.players ?? []).map((p, i) => ({
            steamId: p.steamId, team: slot, rounds,
            kills: 8 + ((i * 3 + rounds) % 15), deaths: 6 + ((i * 5 + rounds) % 12), assists: 2 + (i % 5),
            headshots: 4 + (i % 6), damage: 1200 + i * 150, mvps: i % 4, flashAssists: i % 3, utilityDamage: 40 * i, clutches: i % 2, entryKills: i % 3, entryDeaths: i % 2,
          })),
        );
        const result = await this.api.request('POST', `/server/v1/matches/${matchId}/result`, {
          matchId, mapNumber: map.mapNumber, idempotencyKey: `mock-${matchId}-${map.mapNumber}`,
          scoreA: score.A, scoreB: score.B, rounds, // round time is compressed in the simulation; the report claims a realistic ~95 s per round
          startedAt: new Date(Date.now() - rounds * 95_000).toISOString(), endedAt: new Date().toISOString(), endReason: 'NORMAL', players,
        });
        this.log(`map ${map.mapNumber} result: HTTP ${result.status} ${result.status === 200 ? '' : JSON.stringify(result.data)}`);
      }
    } finally {
      this.playing = null;
    }
  }

  async sendEvent(event: Record<string, unknown>): Promise<void> {
    const seq = ++this.seq;
    await this.api.request('POST', '/server/v1/events', {
      events: [{ seq, idempotencyKey: `mock-${randomUUID()}`, at: Date.now(), matchId: this.currentMatchId, ...event }],
    });
  }
}
