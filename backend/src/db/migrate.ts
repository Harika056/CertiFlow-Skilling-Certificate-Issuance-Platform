import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from './client.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/ (tsx) and dist/ (compiled): migrations live in <backend>/drizzle
export const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations() {
  await migrate(db, { migrationsFolder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => { logger.info('migrations applied'); return pool.end(); })
    .catch((err) => { logger.error({ err }, 'migration failed'); process.exit(1); });
}
