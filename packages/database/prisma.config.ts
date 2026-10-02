import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';
import { fileURLToPath } from 'node:url';

// The single .env lives in the repository root; the package folder is the CLI's working directory.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/seed/index.ts',
  },
  datasource: {
    // `prisma generate` needs no connection; migrate/seed fail with a clear error if this is empty.
    url: process.env.DATABASE_URL ?? '',
  },
});
