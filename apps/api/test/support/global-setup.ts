import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

function migrate(databaseUrl: string): void {
  // Run the Prisma CLI through node directly (no shell, no npx): same behaviour on Windows and Linux.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: join(repoRoot, 'packages', 'database'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * Integration tests need PostgreSQL. Order of preference:
 *  1. TEST_DATABASE_URL (CI service container or your own server – the database must be disposable!)
 *  2. an embedded PostgreSQL started from node_modules (no Docker, no system install)
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    migrate(external);
    project.provide('databaseUrl', external);
    return async () => {};
  }

  const dataDir = join(repoRoot, '.local', 'pgdata-test');
  mkdirSync(dirname(dataDir), { recursive: true });
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'celtist',
    password: 'celtist',
    port,
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase('celtist_test');
  } catch {
    // exists from a previous run
  }
  const url = `postgresql://celtist:celtist@127.0.0.1:${port}/celtist_test`;
  migrate(url);
  project.provide('databaseUrl', url);
  return async () => {
    await pg.stop();
  };
}
