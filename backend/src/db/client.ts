import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema });

export type DB = NodePgDatabase<typeof schema>;
/** A transaction handle; same query API as `db`. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbOrTx = DB | Tx;
