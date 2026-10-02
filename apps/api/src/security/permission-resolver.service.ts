import { Injectable } from '@nestjs/common';
import { effectivePermissions, type Permission } from '@celtist/shared';
import { PrismaService } from '../database/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

const CACHE_TTL_SECONDS = 60;

/** Role → permission resolution with a short Redis cache (invalidated whenever roles change). */
@Injectable()
export class PermissionResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async forUser(userId: string): Promise<ReadonlySet<Permission>> {
    const granted = await this.redis.remember<string[]>(this.key(userId), CACHE_TTL_SECONDS, async () => {
      const rows = await this.prisma.rolePermission.findMany({
        where: { role: { users: { some: { userId } } } },
        select: { permission: true },
      });
      return [...new Set(rows.map((r) => r.permission))];
    });
    return effectivePermissions(granted);
  }

  async rolesForUser(userId: string): Promise<Array<{ key: string; name: string }>> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { select: { key: true, name: true, position: true } } },
      orderBy: { role: { position: 'asc' } },
    });
    return rows.map((r) => ({ key: r.role.key, name: r.role.name }));
  }

  async invalidateUser(userId: string): Promise<void> {
    await this.redis.client.del(this.key(userId)).catch(() => undefined);
  }

  async invalidateAll(): Promise<void> {
    await this.redis.deleteByPrefix('perm:').catch(() => undefined);
  }

  private key(userId: string): string {
    return `perm:${userId}`;
  }
}
