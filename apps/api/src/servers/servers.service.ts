import { Injectable } from '@nestjs/common';
import { isUniqueViolation, type Server } from '@celtist/database';
import { SERVER_OFFLINE_AFTER_MS, type CreateServerInput, type ServerStatus, type UpdateServerInput } from '@celtist/shared';
import { deriveServerKey } from '@celtist/shared/signing';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { Clock } from '../common/clock.js';
import { conflict, notFound } from '../common/errors.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../database/prisma.service.js';
import { ServerAuthService } from '../security/server-auth.js';

/** Status as the outside world sees it: a silent server is OFFLINE even if the cleanup job has not run yet. */
export function effectiveStatus(server: Pick<Server, 'status' | 'lastHeartbeatAt'>, now: Date): ServerStatus {
  if (server.status === 'OFFLINE') return 'OFFLINE';
  if (!server.lastHeartbeatAt || now.getTime() - server.lastHeartbeatAt.getTime() > SERVER_OFFLINE_AFTER_MS) return 'OFFLINE';
  return server.status;
}

export interface ServerCredentials {
  serverId: string;
  /** Hex HMAC key for the plugin's config. Shown once; it cannot be recovered afterwards, only rotated. */
  apiKey: string;
  keyVersion: number;
}

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly serverAuth: ServerAuthService,
  ) {}

  /** Public listing: enough to show availability, nothing about the infrastructure. */
  async listPublic() {
    const now = this.clock.now();
    const servers = await this.prisma.server.findMany({ where: { enabled: true }, orderBy: { name: 'asc' } });
    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      region: s.region,
      status: effectiveStatus(s, now),
      playerCount: s.playerCount,
      maxPlayers: s.maxPlayers,
    }));
  }

  async listAdmin() {
    const now = this.clock.now();
    const servers = await this.prisma.server.findMany({ orderBy: { name: 'asc' }, include: { currentMatch: { select: { id: true, status: true } } } });
    return servers.map((s) => ({ ...this.adminView(s, now), currentMatch: s.currentMatch }));
  }

  async get(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id }, include: { currentMatch: { select: { id: true, status: true } } } });
    if (!server) throw notFound('SERVER_NOT_FOUND', 'Server does not exist');
    return { ...this.adminView(server, this.clock.now()), currentMatch: server.currentMatch };
  }

  async create(input: CreateServerInput, actor: AuditActor, ip?: string | null): Promise<{ server: ReturnType<ServersService['adminView']> } & ServerCredentials> {
    try {
      const server = await this.prisma.server.create({
        data: { name: input.name, ip: input.ip, port: input.port, region: input.region, maxPlayers: input.maxPlayers },
      });
      await this.audit.record({ actor, action: 'server.create', targetType: 'server', targetId: server.id, targetLabel: server.name, newValue: { ...input }, ip });
      return { server: this.adminView(server, this.clock.now()), ...this.credentials(server) };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('SERVER_ADDRESS_TAKEN', 'A server with this IP and port already exists');
      throw error;
    }
  }

  async update(id: string, input: UpdateServerInput, actor: AuditActor, ip?: string | null) {
    const before = await this.prisma.server.findUnique({ where: { id } });
    if (!before) throw notFound('SERVER_NOT_FOUND', 'Server does not exist');
    try {
      const server = await this.prisma.server.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.ip !== undefined ? { ip: input.ip } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.maxPlayers !== undefined ? { maxPlayers: input.maxPlayers } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...(input.maintenanceHold !== undefined ? { maintenanceHold: input.maintenanceHold } : {}),
          ...(input.skinsEnabled !== undefined ? { skinsEnabled: input.skinsEnabled } : {}),
        },
      });
      await this.serverAuth.invalidate(id);
      await this.audit.record({
        actor,
        action: 'server.update',
        targetType: 'server',
        targetId: id,
        targetLabel: server.name,
        oldValue: pick(before, Object.keys(input)),
        newValue: input,
        ip,
      });
      return this.adminView(server, this.clock.now());
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('SERVER_ADDRESS_TAKEN', 'A server with this IP and port already exists');
      throw error;
    }
  }

  /** Issues a new key version: the old key stops working immediately. */
  async rotateKey(id: string, actor: AuditActor, ip?: string | null): Promise<ServerCredentials> {
    const before = await this.prisma.server.findUnique({ where: { id } });
    if (!before) throw notFound('SERVER_NOT_FOUND', 'Server does not exist');
    const server = await this.prisma.server.update({ where: { id }, data: { keyVersion: { increment: 1 } } });
    await this.serverAuth.invalidate(id);
    await this.audit.record({
      actor,
      action: 'server.rotate_key',
      targetType: 'server',
      targetId: id,
      targetLabel: server.name,
      oldValue: { keyVersion: before.keyVersion },
      newValue: { keyVersion: server.keyVersion },
      ip,
    });
    return this.credentials(server);
  }

  async remove(id: string, actor: AuditActor, ip?: string | null): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw notFound('SERVER_NOT_FOUND', 'Server does not exist');
    if (server.currentMatchId) throw conflict('SERVER_IN_USE', 'The server is hosting a match; cancel the match or wait until it ends');
    await this.prisma.server.delete({ where: { id } });
    await this.serverAuth.invalidate(id);
    await this.audit.record({ actor, action: 'server.delete', targetType: 'server', targetId: id, targetLabel: server.name, oldValue: pick(server, ['name', 'ip', 'port', 'region']), ip });
  }

  private credentials(server: Pick<Server, 'id' | 'keyVersion'>): ServerCredentials {
    return {
      serverId: server.id,
      apiKey: deriveServerKey(this.config.env.SERVER_API_SECRET, server.id, server.keyVersion).toString('hex'),
      keyVersion: server.keyVersion,
    };
  }

  adminView(server: Server, now: Date) {
    return {
      id: server.id,
      name: server.name,
      ip: server.ip,
      port: server.port,
      region: server.region,
      status: effectiveStatus(server, now),
      reportedStatus: server.status,
      maxPlayers: server.maxPlayers,
      playerCount: server.playerCount,
      enabled: server.enabled,
      maintenanceHold: server.maintenanceHold,
      skinsEnabled: server.skinsEnabled,
      keyVersion: server.keyVersion,
      pluginVersion: server.pluginVersion,
      gameVersion: server.gameVersion,
      health: server.health,
      lastHeartbeatAt: server.lastHeartbeatAt,
      currentMatchId: server.currentMatchId,
      reservedUntil: server.reservedUntil,
    };
  }
}

function pick<T extends object>(source: T, keys: string[]): Partial<T> {
  return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, (source as Record<string, unknown>)[k]])) as Partial<T>;
}
