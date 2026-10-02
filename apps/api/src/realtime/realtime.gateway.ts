import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { parseCookie } from 'cookie';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.js';
import { DomainEvent } from '../common/domain-events.js';
import { PermissionResolver } from '../security/permission-resolver.service.js';
import { SESSION_COOKIE } from '../security/access.js';
import { SessionService } from '../security/session.service.js';

const subscribeSchema = z.object({ room: z.enum(['match', 'tournament', 'live', 'servers']), id: z.uuid().optional() });

interface SocketData {
  userId?: string;
}

/**
 * Realtime channel (`/realtime`). It only ever pushes small "something changed" events; clients re-fetch the data over
 * REST, so every visibility rule stays in one place (the REST layer) and nothing private can leak through a room.
 * Rooms: match:{id}, tournament:{id}, live (all matches), servers (admins only), user:{id} (joined automatically).
 */
@Injectable()
@WebSocketGateway({ path: '/realtime', transports: ['websocket', 'polling'] })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly sessions: SessionService,
    private readonly permissions: PermissionResolver,
    private readonly config: AppConfig,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.events.onAny((event, payload) => this.route(String(event), (payload ?? {}) as Record<string, unknown>));
  }

  async handleConnection(socket: Socket): Promise<void> {
    // Cross-site WebSocket hijacking guard: a browser always sends Origin; it must be one of ours.
    const origin = socket.handshake.headers.origin;
    const allowed = new Set([this.config.env.PUBLIC_WEB_URL.replace(/\/$/, ''), ...this.config.env.CORS_ORIGINS]);
    if (origin && !allowed.has(origin)) {
      socket.disconnect(true);
      return;
    }
    const token = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
    if (token) {
      const session = await this.sessions.authenticate(token).catch(() => null);
      if (session) {
        (socket.data as SocketData).userId = session.userId;
        await socket.join(`user:${session.userId}`);
      }
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean; error?: string }> {
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'INVALID_SUBSCRIPTION' };
    const { room, id } = parsed.data;
    if (room === 'servers') {
      const userId = (socket.data as SocketData).userId;
      if (!userId || !(await this.permissions.forUser(userId)).has('server.view')) return { ok: false, error: 'FORBIDDEN' };
      await socket.join('servers');
      return { ok: true };
    }
    if (room === 'live') {
      await socket.join('live');
      return { ok: true };
    }
    if (!id) return { ok: false, error: 'INVALID_SUBSCRIPTION' };
    await socket.join(`${room}:${id}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<{ ok: boolean }> {
    const parsed = subscribeSchema.safeParse(body);
    if (parsed.success) await socket.leave(parsed.data.id ? `${parsed.data.room}:${parsed.data.id}` : parsed.data.room);
    return { ok: true };
  }

  /** Translates a domain event into the rooms that care about it. Exposed for tests. */
  route(event: string, payload: Record<string, unknown>): void {
    if (!this.server) return;
    const rooms = new Set<string>();
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    if (event.startsWith('match.')) {
      const matchId = str(payload.matchId);
      if (matchId) rooms.add(`match:${matchId}`);
      rooms.add('live');
      const tid = str(payload.tournamentId);
      if (tid) rooms.add(`tournament:${tid}`);
    } else if (event.startsWith('tournament.')) {
      const tid = str(payload.tournamentId);
      if (tid) rooms.add(`tournament:${tid}`);
    } else if (event.startsWith('server.')) {
      rooms.add('servers');
    } else if (event === DomainEvent.PartyUpdated) {
      for (const id of (payload.userIds as string[] | undefined) ?? []) rooms.add(`user:${id}`);
    } else if (event === DomainEvent.Notification) {
      const uid = str(payload.userId);
      if (uid) rooms.add(`user:${uid}`);
    } else if (event === DomainEvent.RankingChanged) {
      rooms.add('live');
    }
    if (rooms.size === 0) return;
    // Never forward server-side detail: only identifiers and the event name.
    const safe = { event, matchId: str(payload.matchId), tournamentId: str(payload.tournamentId), partyId: str(payload.partyId), serverId: str(payload.serverId) };
    let target = this.server.to([...rooms][0]!);
    for (const room of [...rooms].slice(1)) target = target.to(room);
    target.emit('event', safe);
  }
}
