// Generates a Prisma migration from the current schema WITHOUT interactive prompts (works in CI and for agents).
// Usage: node scripts/gen-migration.mjs <name> [extra.sql]
//   <name>      migration name, e.g. flexible_teams
//   [extra.sql] optional file whose content is appended (CHECK constraints, partial indexes)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [name, extraFile] = process.argv.slice(2);
if (!name) throw new Error('usage: node scripts/gen-migration.mjs <name> [extra.sql]');

const dbDir = new URL('../packages/database/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cli = createRequire(join(dbDir, 'package.json')).resolve('prisma/build/index.js');
let sql = execFileSync(process.execPath, [cli, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script'], {
  cwd: dbDir,
  encoding: 'utf8',
}).replace(/^Loaded Prisma config.*\r?\n/m, '');
if (extraFile) sql += `\n${readFileSync(extraFile, 'utf8')}`;

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const dir = join(dbDir, 'prisma', 'migrations', `${stamp}_${name}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'migration.sql'), sql, 'utf8');
console.log(`Created ${dir}`);
console.log(sql.split('\n').filter((l) => /^(ALTER|DROP|CREATE)/.test(l)).join('\n'));
