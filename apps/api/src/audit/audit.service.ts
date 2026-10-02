import { Global, Injectable, Module } from '@nestjs/common';
import type { PrismaClient, TransactionClient } from '@celtist/database';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthContext } from '../security/access.js';

export interface AuditActor {
  id: string | null;
  label: string;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, label: 'system' };

export function actorFromAuth(auth: Pick<AuthContext, 'userId' | 'displayName'>): AuditActor {
  return { id: auth.userId, label: auth.displayName };
}

export interface AuditEntry {
  actor: AuditActor;
  /** Dotted verb, e.g. "tournament.create", "player.skin_level.set". */
  action: string;
  targetType: string;
  targetId?: string | null;
  targetLabel?: string | null;
  reason?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: unknown;
  ip?: string | null;
}

type Db = PrismaClient | TransactionClient;

/**
 * Append-only audit trail. Pass the transaction client when the audited change runs inside a transaction so
 * the entry commits (or rolls back) together with the change itself.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        actorId: entry.actor.id,
        actorLabel: entry.actor.label.slice(0, 128),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel?.slice(0, 128) ?? null,
        reason: entry.reason ?? null,
        oldValue: toJson(entry.oldValue),
        newValue: toJson(entry.newValue),
        metadata: toJson(entry.metadata),
        ip: entry.ip?.slice(0, 64) ?? null,
      },
    });
  }
}

function toJson(value: unknown): never | undefined {
  if (value === undefined) return undefined;
  // Round-trip drops undefined/functions and turns Dates into ISO strings, which is what the audit view wants.
  return JSON.parse(JSON.stringify(value)) as never;
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
