import { OnEvent } from '@nestjs/event-emitter';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WEBHOOK_EVENTS } from '@celtist/shared';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { DomainEvent, type MatchEventPayload, type TournamentEventPayload } from '../common/domain-events.js';
import { decryptSecret, encryptSecret } from '../common/crypto.js';
import { notFound } from '../common/errors.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { HTTP_FETCH, type HttpFetch } from '../steam/steam-openid.service.js';

type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const COLORS: Record<WebhookEvent, number> = {
  'tournament.created': 0x4a8fe7,
  'match.started': 0x3fa7a0,
  'match.finished': 0x2f9e44,
  'tournament.finished': 0xd4a017,
  'server.offline': 0xe5484d,
};

/**
 * Discord notifications. Webhook URLs are secrets: they are stored AES-256-GCM encrypted and shown in the panel only
 * masked. Delivery never blocks or fails the action that caused it; failures are recorded on the endpoint.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(HTTP_FETCH) private readonly fetcher: HttpFetch,
  ) {}

  async list() {
    const rows = await this.prisma.webhookEndpoint.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((w) => ({ id: w.id, name: w.name, events: w.events, enabled: w.enabled, url: this.mask(this.decrypt(w.urlEncrypted)), lastDeliveryAt: w.lastDeliveryAt, lastError: w.lastError }));
  }

  async create(input: { name: string; url: string; events: string[]; enabled: boolean }, actor: AuditActor, userId: string, ip?: string | null) {
    const row = await this.prisma.webhookEndpoint.create({ data: { name: input.name, urlEncrypted: encryptSecret(input.url, this.config.env.ENCRYPTION_KEY), events: input.events, enabled: input.enabled, createdById: userId } });
    await this.audit.record({ actor, action: 'webhook.create', targetType: 'webhook', targetId: row.id, targetLabel: row.name, newValue: { events: input.events, enabled: input.enabled }, ip });
    return { id: row.id };
  }

  async update(id: string, patch: { name?: string; url?: string; events?: string[]; enabled?: boolean }, actor: AuditActor, ip?: string | null) {
    const before = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!before) throw notFound('WEBHOOK_NOT_FOUND', 'Webhook does not exist');
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { urlEncrypted: encryptSecret(patch.url, this.config.env.ENCRYPTION_KEY) } : {}),
        ...(patch.events !== undefined ? { events: patch.events } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    });
    await this.audit.record({ actor, action: 'webhook.update', targetType: 'webhook', targetId: id, targetLabel: before.name, oldValue: { events: before.events, enabled: before.enabled }, newValue: { ...patch, url: patch.url ? '[changed]' : undefined }, ip });
  }

  async remove(id: string, actor: AuditActor, ip?: string | null) {
    const before = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!before) throw notFound('WEBHOOK_NOT_FOUND', 'Webhook does not exist');
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.audit.record({ actor, action: 'webhook.delete', targetType: 'webhook', targetId: id, targetLabel: before.name, ip });
  }

  /** Sends a test message so admins can verify a new URL. */
  async test(id: string): Promise<{ ok: boolean; error?: string }> {
    const hook = await this.prisma.webhookEndpoint.findUnique({ where: { id } });
    if (!hook) throw notFound('WEBHOOK_NOT_FOUND', 'Webhook does not exist');
    return this.deliver(hook.id, this.decrypt(hook.urlEncrypted), { title: 'Celtist webhook test', description: 'If you can read this, the webhook works.', color: 0x4a8fe7 });
  }

  // ─────────────── event wiring ───────────────

  @OnEvent(DomainEvent.TournamentCreated)
  async onTournamentCreated(p: TournamentEventPayload) {
    const t = await this.prisma.tournament.findUnique({ where: { id: p.tournamentId } });
    if (t && t.visibility === 'PUBLIC' && t.status !== 'DRAFT') await this.broadcast('tournament.created', `Tournament created: ${t.name}`, `${t.format.replace('_', ' ').toLowerCase()} · ${t.teamSize}v${t.teamSize} · starts ${t.startsAt.toISOString()}`);
    // Drafts are announced when published; the event still fires on creation, so only public non-drafts are posted here.
  }

  @OnEvent(DomainEvent.MatchStarted)
  async onMatchStarted(p: MatchEventPayload) {
    const text = await this.matchText(p.matchId);
    if (text) await this.broadcast('match.started', 'Match started', text);
  }

  @OnEvent(DomainEvent.MatchFinished)
  async onMatchFinished(p: MatchEventPayload) {
    const text = await this.matchText(p.matchId, true);
    if (text) await this.broadcast('match.finished', 'Match finished', text);
  }

  @OnEvent(DomainEvent.TournamentFinished)
  async onTournamentFinished(p: TournamentEventPayload) {
    const t = await this.prisma.tournament.findUnique({ where: { id: p.tournamentId }, include: { teams: { where: { placement: 1 }, select: { name: true } } } });
    if (t) await this.broadcast('tournament.finished', `${t.name} is over`, t.teams[0] ? `Champion: **${t.teams[0].name}**` : 'The tournament has ended.');
  }

  @OnEvent(DomainEvent.ServerOffline)
  async onServerOffline(p: { serverId: string }) {
    const s = await this.prisma.server.findUnique({ where: { id: p.serverId }, select: { name: true } });
    if (s) await this.broadcast('server.offline', 'Server offline', `${s.name} stopped sending heartbeats.`);
  }

  private async matchText(matchId: string, withScore = false): Promise<string | null> {
    const m = await this.prisma.match.findUnique({ where: { id: matchId }, include: { teams: true, tournamentMatch: { include: { tournament: { select: { name: true } } } } } });
    if (!m || m.teams.length < 2) return null;
    const a = m.teams.find((t) => t.slot === 'A')!;
    const b = m.teams.find((t) => t.slot === 'B')!;
    const where = m.tournamentMatch ? ` (${m.tournamentMatch.tournament.name})` : '';
    return withScore ? `**${a.name}** ${a.seriesScore} : ${b.seriesScore} **${b.name}**${where}` : `${a.name} vs ${b.name}${where}`;
  }

  /** Posts to the env webhook and to every enabled endpoint that subscribed to the event. Never throws. */
  async broadcast(event: WebhookEvent, title: string, description: string): Promise<void> {
    const embed = { title, description, color: COLORS[event], timestamp: this.clock.now().toISOString() };
    const targets: Array<{ id: string | null; url: string }> = [];
    if (this.config.env.DISCORD_WEBHOOK) targets.push({ id: null, url: this.config.env.DISCORD_WEBHOOK });
    const rows = await this.prisma.webhookEndpoint.findMany({ where: { enabled: true, events: { has: event } } }).catch(() => []);
    for (const row of rows) targets.push({ id: row.id, url: this.decrypt(row.urlEncrypted) });
    await Promise.all(targets.map((t) => this.deliver(t.id, t.url, embed)));
  }

  private async deliver(id: string | null, url: string, embed: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const response = await this.fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Celtist', embeds: [embed] }), signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          if (id) await this.prisma.webhookEndpoint.update({ where: { id }, data: { lastDeliveryAt: this.clock.now(), lastError: null } }).catch(() => undefined);
          return { ok: true };
        }
        if (response.status === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw new Error(`Discord answered ${response.status}`);
      } catch (error) {
        if (attempt < 3 && !/answered 4\d\d/.test((error as Error).message)) {
          await new Promise((r) => setTimeout(r, 300 * attempt));
          continue;
        }
        this.logger.warn(`Webhook delivery failed: ${(error as Error).message}`);
        if (id) await this.prisma.webhookEndpoint.update({ where: { id }, data: { lastError: (error as Error).message.slice(0, 200) } }).catch(() => undefined);
        return { ok: false, error: (error as Error).message };
      }
    }
  }

  private decrypt(value: string): string {
    return decryptSecret(value, this.config.env.ENCRYPTION_KEY);
  }

  private mask(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}/…${u.pathname.slice(-4)}`;
    } catch {
      return '…';
    }
  }
}
