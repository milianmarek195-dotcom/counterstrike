import { Prisma } from './generated/prisma/client.js';

function code(error: unknown): string | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
}

/** P2002: unique constraint failed – the signal used for idempotent inserts. */
export function isUniqueViolation(error: unknown, ...fields: string[]): boolean {
  if (code(error) !== 'P2002') return false;
  if (fields.length === 0) return true;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as
    | { target?: string[] | string; driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } }
    | undefined;
  const target = meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields;
  const list = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
  return fields.every((f) => list.some((t) => t.includes(f)));
}

/** P2025: record required by the operation was not found. */
export function isRecordNotFound(error: unknown): boolean {
  return code(error) === 'P2025';
}
