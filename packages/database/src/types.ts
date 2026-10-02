import type { Prisma } from './generated/prisma/client.js';

/** Interactive-transaction client handed to `prisma.$transaction(async (tx) => …)`. */
export type TransactionClient = Prisma.TransactionClient;
