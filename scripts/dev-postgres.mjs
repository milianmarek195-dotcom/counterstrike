// Local PostgreSQL for machines without Docker (npm package `embedded-postgres`, no system install).
// Usage: node scripts/dev-postgres.mjs        (keeps running; Ctrl+C stops it cleanly)
// Data lives in .local/pgdata (git-ignored). Databases: celtist_dev (dev) and celtist_test (tests).
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.local', 'pgdata');
const port = Number(process.env.DEV_PG_PORT ?? 54329);
const user = process.env.DEV_PG_USER ?? 'celtist';
const password = process.env.DEV_PG_PASSWORD ?? 'celtist';

mkdirSync(dirname(dataDir), { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  // The server encoding must be UTF8: skin names contain CJK characters, and the Windows default (WIN1252) rejects them.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
});

if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  console.log('Initialising new data directory …');
  await pg.initialise();
}
await pg.start();

for (const db of ['celtist_dev', 'celtist_test']) {
  try {
    await pg.createDatabase(db);
    console.log(`Created database ${db}`);
  } catch {
    // already exists
  }
}

console.log(`PostgreSQL ready on postgresql://${user}:${password}@localhost:${port}/celtist_dev`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('Stopping PostgreSQL …');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
