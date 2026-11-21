import pg from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';

/** Fresh schema once per test run, built from the real migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/certiflow_test';
  const pool = new pg.Pool({ connectionString: url });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  await pool.end();
}
