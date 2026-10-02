import { EventEmitter2 } from '@nestjs/event-emitter';
import { Controller, Get, Global, HttpCode, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DomainEvent, type NotificationEventPayload } from '../common/domain-events.js';
import { PrismaService } from '../database/prisma.service.js';
import { Authenticated, CurrentAuth, type AuthContext } from '../security/access.js';

export interface NotifyInput {
  userId: string;
  /** Stable machine type, e.g. party.invite, match.created. */
  type: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async notify(input: NotifyInput): Promise<void> {
    const row = await this.prisma.notification.create({
      data: { userId: input.userId, type: input.type, title: input.title.slice(0, 120), body: input.body ?? null, data: (input.data ?? undefined) as never },
    });
    this.events.emit(DomainEvent.Notification, { userId: input.userId, notificationId: row.id } satisfies NotificationEventPayload);
  }

  async list(userId: string, unreadOnly: boolean, limit: number) {
    const [items, unread] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId, ...(unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: 'desc' }, take: limit }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { unread, notifications: items };
  }

  async markRead(userId: string, id: string | 'all'): Promise<void> {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(id === 'all' ? {} : { id }) }, data: { readAt: new Date() } });
  }
}

const listQuery = z.object({ unread: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(100).default(30) });

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Authenticated()
  list(@CurrentAuth() auth: AuthContext, @Query({ schema: listQuery }) query: z.infer<typeof listQuery>) {
    return this.notifications.list(auth.userId, query.unread, query.limit);
  }

  @Post('read-all')
  @Authenticated()
  @HttpCode(204)
  async readAll(@CurrentAuth() auth: AuthContext): Promise<void> {
    await this.notifications.markRead(auth.userId, 'all');
  }

  @Post(':id/read')
  @Authenticated()
  @HttpCode(204)
  async read(@CurrentAuth() auth: AuthContext, @Param('id', { schema: z.uuid() }) id: string): Promise<void> {
    await this.notifications.markRead(auth.userId, id);
  }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
