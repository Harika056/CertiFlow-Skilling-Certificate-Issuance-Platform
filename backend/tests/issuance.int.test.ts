import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { batches, candidates, certificates, deliveries, escalations } from '../src/db/schema.js';
import { createMockWhatsApp } from '../src/mock-whatsapp/app.js';
import { startWorkers } from '../src/jobs/processors.js';
import { createRedis } from '../src/lib/redis.js';
import { issueBatch, generatePdf, signDownloadToken } from '../src/services/certificateService.js';
import { deliverCertificate } from '../src/services/deliveryService.js';
import { escalateStuckBatches } from '../src/services/slaService.js';
import { api, batchByRef, login, resetDb, waitFor } from './helpers.js';

// A deliberately bad WhatsApp: 30% errors, 20% hangs past our 300ms timeout
// (half of which DO deliver - the response is just lost).
const mock = createMockWhatsApp({ failRate: 0.3, timeoutRate: 0.2, hangMs: 600 });
let server: Server;
let workers: Awaited<ReturnType<typeof startWorkers>>;
const conn = createRedis();
const pub = createRedis();

beforeAll(async () => {
  server = mock.app.listen(4199);
  // Clean queues from earlier runs, then start real workers in-process.
  const keys = await conn.keys('cf:*');
  if (keys.length) await conn.del(...keys);
  workers = await startWorkers(conn, pub, { sla: false });
});
afterAll(async () => {
  await workers.close();
  server.close();
  conn.disconnect(); pub.disconnect();
});
beforeEach(async () => {
  await resetDb();
  mock.inbox.clear();
});

async function sentFor(batchId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(deliveries)
    .innerJoin(certificates, eq(certificates.id, deliveries.certificateId))
    .where(sql`${certificates.batchId} = ${batchId} AND ${deliveries.status} = 'SENT'`);
  return r!.n;
}

async function approveThroughAllSteps(ref: string) {
  const b = await batchByRef(ref);
  const vote = async (u: string) => api().post(`/api/batches/${b.id}/votes`).set('authorization', `Bearer ${await login(u)}`).send({ decision: 'APPROVE' });
  await vote('dev'); await vote('meera'); await vote('neha'); await vote('farah');
  expect((await batchByRef(ref)).status).not.toBe('DISTRICT_REVIEW');
  return b;
}

describe('Moment 3: a batch of 60 is approved over an unreliable WhatsApp', () => {
  it('gives every candidate exactly one certificate on their phone', async () => {
    const b = await approveThroughAllSteps('B-DEMO-LARGE');

    await waitFor(async () => (await sentFor(b.id)) === 60, 50_000);

    const certs = await db.select().from(certificates).where(eq(certificates.batchId, b.id));
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.certNumber)).size).toBe(60);        // unique numbers
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);       // one per candidate

    const phones = (await db.select().from(candidates).where(eq(candidates.batchId, b.id))).map((c) => c.phone);
    for (const p of phones) expect(mock.inbox.get(p) ?? []).toHaveLength(1); // exactly one message each
    expect(mock.stats.failed + mock.stats.timedOut).toBeGreaterThan(0);      // the chaos really happened
    expect((await batchByRef('B-DEMO-LARGE')).status).toBe('ISSUED');
  });

  it('stays exactly-once when every step is replayed (worker crash / duplicate event)', async () => {
    const b = await approveThroughAllSteps('B-DEMO-SMALL');
    await waitFor(async () => (await sentFor(b.id)) === 6);

    // Replay everything as if events were delivered again after a crash.
    expect((await issueBatch(b.id)).created).toBe(0);
    const certs = await db.select().from(certificates).where(eq(certificates.batchId, b.id));
    for (const c of certs) {
      await generatePdf(c.id);
      await deliverCertificate(c.id);
    }
    expect(await db.select().from(certificates).where(eq(certificates.batchId, b.id))).toHaveLength(6);
    for (const c of await db.select().from(candidates).where(eq(candidates.batchId, b.id))) {
      expect(mock.inbox.get(c.phone)).toHaveLength(1);
    }
  });

  it('never issues a second certificate to someone already certified for the course', async () => {
    const b = await approveThroughAllSteps('B-DEMO-SMALL');
    await waitFor(async () => (await batchByRef('B-DEMO-SMALL')).status === 'ISSUED');
    // A second batch smuggles in the same person for the same course; upload validation
    // is bypassed on purpose to prove the database constraint still holds.
    const [copy] = await db.insert(batches).values({ ...b, id: undefined, reference: 'B-COPY', status: 'APPROVED' } as never).returning();
    const orig = await db.select().from(candidates).where(eq(candidates.batchId, b.id));
    await db.insert(candidates).values(orig.map((c) => ({ ...c, id: undefined, batchId: copy!.id })) as never);
    await issueBatch(copy!.id);
    expect(await db.select().from(certificates).where(eq(certificates.batchId, copy!.id))).toHaveLength(0);
  });
});

describe('Moment 4: the state office cancels a certificate', () => {
  it('tells an employer it is no longer valid straight away, even after a cached lookup', async () => {
    const b = await approveThroughAllSteps('B-DEMO-SMALL');
    await waitFor(async () => (await db.select().from(certificates).where(eq(certificates.batchId, b.id))).length === 6);
    const [cert] = await db.select().from(certificates).where(eq(certificates.batchId, b.id)).limit(1);

    const first = await api().get(`/api/public/verify/${cert!.verificationCode}`);
    expect(first.body.result).toBe('VALID');
    expect(JSON.stringify(first.body)).not.toMatch(/\+91|phone|score/); // no personal data leaks

    const farah = await login('farah');
    const rev = await api().post(`/api/certificates/by-number/${cert!.certNumber}/revoke`).set('authorization', `Bearer ${farah}`).send({ reason: 'Forged marks' });
    expect(rev.status).toBe(200);

    const after = await api().get(`/api/public/verify/${cert!.verificationCode}`);
    expect(after.body.result).toBe('REVOKED');

    // Revoked certificates can't be downloaded or reinstated.
    await waitFor(async () => (await db.select().from(certificates).where(eq(certificates.id, cert!.id)))[0]!.pdfStatus === 'READY');
    expect((await api().get(`/api/public/certificates/download/${signDownloadToken(cert!.id)}`)).status).toBe(409);
    await expect(db.update(certificates).set({ status: 'VALID' }).where(eq(certificates.id, cert!.id))).rejects.toThrow();
  });

  it('only the state office can cancel', async () => {
    const b = await approveThroughAllSteps('B-DEMO-SMALL');
    await waitFor(async () => (await db.select().from(certificates).where(eq(certificates.batchId, b.id))).length === 6);
    const [cert] = await db.select().from(certificates).where(eq(certificates.batchId, b.id)).limit(1);
    for (const u of ['anika', 'dev', 'neha']) {
      const r = await api().post(`/api/certificates/by-number/${cert!.certNumber}/revoke`).set('authorization', `Bearer ${await login(u)}`).send({ reason: 'nope' });
      expect(r.status).toBe(403);
    }
  });

  it('does not let strangers guess certificates or forge download links', async () => {
    expect((await api().get('/api/public/verify/PSM-2026-0000001')).body.result).toBe('NOT_FOUND'); // number alone is not enough
    expect((await api().get('/api/public/certificates/download/eyJhbGciOiJIUzI1NiJ9.e30.tampered')).status).toBe(403);
  });
});

describe('Moment 5: a batch sits with an officer too long', () => {
  it('escalates to the state office once, without anyone chasing', async () => {
    const stuck = await batchByRef('B-DEMO-STUCK');
    // Three scanners at once (e.g. three worker instances) still raise ONE escalation.
    await Promise.all([escalateStuckBatches(), escalateStuckBatches(), escalateStuckBatches()]);
    await escalateStuckBatches();
    const rows = await db.select().from(escalations).where(eq(escalations.batchId, stuck.id));
    expect(rows).toHaveLength(1);

    const view = await api().get('/api/state/stuck').set('authorization', `Bearer ${await login('farah')}`);
    expect(view.body.waiting.find((w: { reference: string }) => w.reference === 'B-DEMO-STUCK').escalatedAt).toBeTruthy();
    // Fresh batches are not escalated.
    expect(await db.select().from(escalations).where(eq(escalations.batchId, (await batchByRef('B-DEMO-SMALL')).id))).toHaveLength(0);
  });
});
