import type { PrismaClient } from '@celtist/database';

let tableList: string[] | null = null;

/** Empties every application table (keeps the migration history). */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  if (!tableList) {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    tableList = rows.map((r) => `"${r.tablename}"`);
  }
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList.join(', ')} RESTART IDENTITY CASCADE`);
}
