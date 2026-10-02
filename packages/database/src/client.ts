import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export interface CreatePrismaClientOptions {
  /** Max connections in the pg pool (default 10). */
  poolSize?: number;
  /** Log slow/failed queries through Prisma's event log. */
  log?: boolean;
}

/** `pg` driver adapter (mandatory in Prisma 7). */
export function createPrismaAdapter(connectionString: string, poolSize = 10): PrismaPg {
  return new PrismaPg({ connectionString, max: poolSize });
}

/**
 * Creates a standalone Prisma client (scripts, seed, tests). The API uses PrismaService, which extends
 * PrismaClient with the same adapter.
 */
export function createPrismaClient(
  connectionString: string,
  options: CreatePrismaClientOptions = {},
): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaAdapter(connectionString, options.poolSize),
    log: options.log ? [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }] : [],
  });
}
