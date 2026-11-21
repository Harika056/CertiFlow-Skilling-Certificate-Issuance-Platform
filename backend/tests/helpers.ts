import request from 'supertest';
import { sql, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { users, batches } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { redis } from '../src/lib/redis.js';
import type { Actor } from '../src/domain/workflow.js';

export const { app } = createApp();
export const api = () => request(app);

export async function resetDb() {
  await db.execute(sql`TRUNCATE escalations, deliveries, certificates, review_votes, candidates, batches, users, centres, districts, outbox RESTART IDENTITY CASCADE`);
  // audit_log is append-only via trigger; tests are allowed to bypass it.
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update`);
  await db.execute(sql`TRUNCATE audit_log RESTART IDENTITY`);
  await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update`);
  // Only clear cache/rate-limit keys; queue keys belong to running workers.
  const keys = [...await redis.keys('verify:*'), ...await redis.keys('rl:*')];
  if (keys.length) await redis.del(...keys);
  await seed();
}

export async function login(username: string): Promise<string> {
  const res = await api().post('/api/auth/demo-login').send({ username });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status}`);
  return res.body.token;
}

export async function actor(username: string): Promise<Actor> {
  const [u] = await db.select().from(users).where(eq(users.username, username));
  return { id: u!.id, role: u!.role, displayName: u!.displayName, centreId: u!.centreId, districtId: u!.districtId };
}

export async function batchByRef(ref: string) {
  const [b] = await db.select().from(batches).where(eq(batches.reference, ref));
  return b!;
}

export function csv(rows: string[][]): Buffer {
  return Buffer.from(rows.map((r) => r.join(',')).join('\n'));
}

export function goodRows(n: number, prefix = 'NEW', phoneStart = 9123400000): string[][] {
  const out = [['enrolment_id', 'full_name', 'phone', 'score']];
  for (let i = 0; i < n; i++) out.push([`${prefix}-${i + 1}`, `Candidate ${String.fromCharCode(65 + (i % 26))}`, String(phoneStart + i), '72']);
  return out;
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 30_000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}
