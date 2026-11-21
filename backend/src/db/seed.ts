/**
 * Demo data: the six people from the brief plus a second district so you can
 * see that officers cannot touch batches outside their area.
 * Idempotent: running it twice does nothing the second time.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from './client.js';
import { batches, candidates, centres, districts, reviewVotes, users, outbox, auditLog } from './schema.js';
import { logger } from '../lib/logger.js';

const FIRST = ['Aarav', 'Diya', 'Ishaan', 'Kavya', 'Rohan', 'Saanvi', 'Arjun', 'Ananya', 'Vihaan', 'Meher', 'Kabir', 'Priya', 'Aditya', 'Lakshmi', 'Farhan', 'Zoya', 'Siddharth', 'Pooja', 'Imran', 'Nisha'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Khan', 'Patel', 'Das', 'Naidu', 'Singh', 'Menon', 'Gupta'];

export function demoCandidates(prefix: string, n: number, phoneStart: number) {
  return Array.from({ length: n }, (_, i) => ({
    enrolmentId: `${prefix}-${String(i + 1).padStart(4, '0')}`,
    fullName: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    phone: `+91${phoneStart + i}`,
    score: String(55 + ((i * 13) % 45)),
    rowNumber: i + 2,
  }));
}

export async function seed() {
  const existing = await db.select().from(users).limit(1);
  if (existing.length) { logger.info('seed: data already present, skipping'); return; }

  await db.transaction(async (tx) => {
    const [north, south] = await tx.insert(districts).values([{ name: 'North District' }, { name: 'South District' }]).returning();
    const [sunrise, coastal] = await tx.insert(centres).values([
      { code: 'SUN01', name: 'Sunrise Skills Centre', districtId: north!.id },
      { code: 'CST01', name: 'Coastal Training Institute', districtId: south!.id },
    ]).returning();

    const u = await tx.insert(users).values([
      { username: 'anika', displayName: 'Anika', role: 'CENTRE', centreId: sunrise!.id },
      { username: 'dev', displayName: 'Dev', role: 'DISTRICT_OFFICER', districtId: north!.id },
      { username: 'meera', displayName: 'Meera', role: 'DISTRICT_OFFICER', districtId: north!.id },
      { username: 'kabir', displayName: 'Kabir', role: 'DISTRICT_OFFICER', districtId: north!.id },
      { username: 'neha', displayName: 'Neha', role: 'QUALITY' },
      { username: 'farah', displayName: 'Farah', role: 'STATE' },
      // Extra (not in the brief): a second district to show scoping.
      { username: 'ravi', displayName: 'Ravi', role: 'CENTRE', centreId: coastal!.id },
      { username: 'omar', displayName: 'Omar', role: 'DISTRICT_OFFICER', districtId: south!.id },
    ]).returning();
    const by = Object.fromEntries(u.map((x) => [x.username, x]));

    const now = Date.now();
    const mk = async (o: {
      ref: string; title: string; course: string; status: typeof batches.$inferInsert['status']; round: number;
      n: number; prefix: string; phoneStart: number; enteredHoursAgo?: number;
    }) => {
      const [b] = await tx.insert(batches).values({
        reference: o.ref, title: o.title, course: o.course, centreId: sunrise!.id, districtId: north!.id,
        status: o.status, round: o.round, candidateCount: o.n, createdBy: by.anika!.id,
        stageEnteredAt: new Date(now - (o.enteredHoursAgo ?? 0.2) * 3600_000),
      }).returning();
      await tx.insert(candidates).values(demoCandidates(o.prefix, o.n, o.phoneStart).map((c) => ({ ...c, batchId: b!.id })));
      await tx.insert(auditLog).values({ actorId: by.anika!.id, actorName: 'Anika (CENTRE)', action: 'SEEDED', entityType: 'batch', entityId: b!.id, batchId: b!.id, details: { status: o.status }, traceId: 'seed' });
      return b!;
    };

    await mk({ ref: 'B-DEMO-DRAFT', title: 'Electrician - January cohort', course: 'Assistant Electrician', status: 'DRAFT', round: 0, n: 8, prefix: 'ELE26', phoneStart: 9876500000 });
    await mk({ ref: 'B-DEMO-SMALL', title: 'Retail Sales - small batch', course: 'Retail Sales Associate', status: 'DISTRICT_REVIEW', round: 1, n: 6, prefix: 'RET26', phoneStart: 9876510000 });
    await mk({ ref: 'B-DEMO-LARGE', title: 'Data Entry - large batch (60)', course: 'Data Entry Operator', status: 'DISTRICT_REVIEW', round: 1, n: 60, prefix: 'DEO26', phoneStart: 9876520000 });
    await mk({ ref: 'B-DEMO-STUCK', title: 'Plumbing - waiting 3 days', course: 'Plumber General', status: 'DISTRICT_REVIEW', round: 1, n: 5, prefix: 'PLB26', phoneStart: 9876530000, enteredHoursAgo: 72 });
    const tail = await mk({ ref: 'B-DEMO-STATE', title: 'Tailoring - awaiting state', course: 'Sewing Machine Operator', status: 'STATE_REVIEW', round: 1, n: 10, prefix: 'TLR26', phoneStart: 9876540000 });
    await tx.insert(reviewVotes).values([
      { batchId: tail.id, round: 1, stage: 'DISTRICT', actorId: by.dev!.id, decision: 'APPROVE' },
      { batchId: tail.id, round: 1, stage: 'DISTRICT', actorId: by.meera!.id, decision: 'APPROVE' },
    ]);
    // Approved batch: the worker picks up this event and issues + delivers on startup.
    const appr = await mk({ ref: 'B-DEMO-APPROVED', title: 'Beauty & Wellness - approved', course: 'Assistant Beauty Therapist', status: 'APPROVED', round: 1, n: 5, prefix: 'BEA26', phoneStart: 9876550000 });
    await tx.insert(outbox).values({ type: 'BatchApproved', aggregateId: appr.id, payload: { scope: { batchId: appr.id, centreId: sunrise!.id, districtId: north!.id }, data: {} }, traceId: 'seed' });
  });
  logger.info('seed: demo data created');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(() => pool.end()).catch((err) => { logger.error({ err }, 'seed failed'); process.exit(1); });
}
