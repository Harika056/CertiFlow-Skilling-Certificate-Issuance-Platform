import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { db } from '../src/db/client.js';
import { auditLog, candidates, outbox, reviewVotes } from '../src/db/schema.js';
import { api, batchByRef, csv, goodRows, login, resetDb } from './helpers.js';

beforeEach(resetDb);

const vote = (token: string, batchId: string, body: object) =>
  api().post(`/api/batches/${batchId}/votes`).set('authorization', `Bearer ${token}`).send(body);

describe('Moment 1: upload with bad rows', () => {
  it('lists exactly what is wrong and saves nothing', async () => {
    const anika = await login('anika');
    const draft = await batchByRef('B-DEMO-DRAFT');
    const before = await db.select().from(candidates).where(eq(candidates.batchId, draft.id));

    const rows = goodRows(10);
    rows[4] = ['NEW-4', 'Bad Phone', '123', '70'];      // spreadsheet row 5
    rows[7] = ['NEW-7', 'Low Score', '9123400007', '10']; // spreadsheet row 8
    const res = await api().post(`/api/batches/${draft.id}/candidates`).set('authorization', `Bearer ${anika}`)
      .attach('file', csv(rows), 'batch.csv');

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Nothing was saved/);
    expect(res.body.error.details.errors.map((e: { row: number }) => e.row)).toEqual([5, 8]);

    const after = await db.select().from(candidates).where(eq(candidates.batchId, draft.id));
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort()); // untouched
    expect((await batchByRef('B-DEMO-DRAFT')).candidateCount).toBe(8);
  });

  it('replaces the list atomically when the file is clean', async () => {
    const anika = await login('anika');
    const draft = await batchByRef('B-DEMO-DRAFT');
    const res = await api().post(`/api/batches/${draft.id}/candidates`).set('authorization', `Bearer ${anika}`)
      .attach('file', csv(goodRows(12)), 'batch.csv');
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(12);
    expect((await batchByRef('B-DEMO-DRAFT')).candidateCount).toBe(12);
  });
});

describe('Moment 2: two officers approve at the same moment', () => {
  it('moves the batch forward exactly once', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const tokens = await Promise.all(['dev', 'meera', 'kabir'].map(login));

    // All three fire together; only two approvals are needed.
    const results = await Promise.all(tokens.map((t) => vote(t, b.id, { decision: 'APPROVE' })));
    const moved = results.filter((r) => r.status === 200 && r.body.moved);
    expect(moved).toHaveLength(1);
    // The late one is told clearly that the batch already moved on.
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);

    expect((await batchByRef('B-DEMO-SMALL')).status).toBe('STATE_REVIEW');
    const transitions = await db.select().from(auditLog)
      .where(and(eq(auditLog.batchId, b.id), eq(auditLog.action, 'BATCH_STAGE_CHANGED')));
    expect(transitions).toHaveLength(1);
    const events = await db.select().from(outbox).where(and(eq(outbox.aggregateId, b.id), eq(outbox.type, 'BatchStageChanged')));
    expect(events).toHaveLength(1);
  });

  it('never counts the same officer twice, even on a double click', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const dev = await login('dev');
    const [r1, r2] = await Promise.all([vote(dev, b.id, { decision: 'APPROVE' }), vote(dev, b.id, { decision: 'APPROVE' })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await batchByRef('B-DEMO-SMALL')).status).toBe('DISTRICT_REVIEW');
  });

  it('sends large batches to the quality team', async () => {
    const b = await batchByRef('B-DEMO-LARGE');
    await vote(await login('dev'), b.id, { decision: 'APPROVE' });
    await vote(await login('meera'), b.id, { decision: 'APPROVE' });
    expect((await batchByRef('B-DEMO-LARGE')).status).toBe('QUALITY_REVIEW');
    expect((await vote(await login('farah'), b.id, { decision: 'APPROVE' })).status).toBe(403);
    expect((await vote(await login('neha'), b.id, { decision: 'APPROVE' })).body.status).toBe('STATE_REVIEW');
  });
});

describe('Never: acting at a step that is not yours, or as someone else', () => {
  it('blocks the wrong role, the wrong district and the wrong stage', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    expect((await vote(await login('anika'), b.id, { decision: 'APPROVE' })).status).toBe(403); // centre
    expect((await vote(await login('omar'), b.id, { decision: 'APPROVE' })).status).toBe(404);  // other district: cannot even see it
    expect((await vote(await login('farah'), b.id, { decision: 'APPROVE' })).status).toBe(403); // state at district step
    expect((await vote(await login('neha'), b.id, { decision: 'APPROVE' })).status).toBe(403);  // quality at district step
  });

  it('rejects requests that try to smuggle in an identity or extra fields', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const dev = await login('dev');
    // Identity only ever comes from the signed token. A body claiming another
    // actor or role is treated as tampering and refused outright.
    const res = await vote(dev, b.id, { decision: 'APPROVE', actorId: 'someone-else', role: 'STATE' });
    expect(res.status).toBe(400);
    expect(await db.select().from(reviewVotes).where(eq(reviewVotes.batchId, b.id))).toHaveLength(0);
    expect((await vote(dev, b.id, { decision: 'APPROVE; DROP TABLE batches' })).status).toBe(400);
    expect((await vote(dev, 'not-a-uuid', { decision: 'APPROVE' })).status).toBe(404);
  });

  it('rejects a token signed with the wrong key or with alg=none', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const forged = jwt.sign({ sub: 'x' }, 'not-the-secret', { issuer: 'certiflow' });
    expect((await vote(forged, b.id, { decision: 'APPROVE' })).status).toBe(401);
    const none = jwt.sign({ sub: 'x', iss: 'certiflow' }, '', { algorithm: 'none' });
    expect((await vote(none, b.id, { decision: 'APPROVE' })).status).toBe(401);
    expect((await api().get('/api/batches')).status).toBe(401);
  });

  it('hides a centre\'s batches and candidate phones from others', async () => {
    const draft = await batchByRef('B-DEMO-DRAFT');
    expect((await api().get(`/api/batches/${draft.id}`).set('authorization', `Bearer ${await login('ravi')}`)).status).toBe(404);
    expect((await api().get(`/api/batches/${draft.id}`).set('authorization', `Bearer ${await login('dev')}`)).status).toBe(404); // drafts are private
    const small = await batchByRef('B-DEMO-SMALL');
    const asDev = await api().get(`/api/batches/${small.id}`).set('authorization', `Bearer ${await login('dev')}`);
    expect(asDev.body.candidates[0].phone).toMatch(/\*{6}/);
  });
});

describe('Moment 6: send back, fix, resubmit', () => {
  it('starts a new round in which earlier approvals no longer count', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const [dev, meera, kabir, anika] = await Promise.all(['dev', 'meera', 'kabir', 'anika'].map(login));

    await vote(dev, b.id, { decision: 'APPROVE' });                       // round 1: 1 approval
    const back = await vote(kabir, b.id, { decision: 'RETURN', reason: 'Row 3 has wrong surname' });
    expect(back.body.status).toBe('RETURNED');
    expect((await vote(meera, b.id, { decision: 'RETURN' })).status).toBe(400); // a reason is mandatory

    const fix = await api().post(`/api/batches/${b.id}/candidates`).set('authorization', `Bearer ${anika}`).attach('file', csv(goodRows(6)), 'fixed.csv');
    expect(fix.status).toBe(200);
    const sub = await api().post(`/api/batches/${b.id}/submit`).set('authorization', `Bearer ${anika}`);
    expect(sub.body.round).toBe(2);

    // Dev's round-1 approval does not carry over: one new approval is not enough.
    const r = await vote(meera, b.id, { decision: 'APPROVE' });
    expect(r.body).toMatchObject({ moved: false, votes: 1, needed: 2 });
    // ...and Dev can (must) approve again in the new round.
    expect((await vote(dev, b.id, { decision: 'APPROVE' })).body.moved).toBe(true);

    const trail = (await db.select().from(auditLog).where(eq(auditLog.batchId, b.id))).map((a) => a.action);
    expect(trail).toEqual(expect.arrayContaining(['VOTE_APPROVE', 'VOTE_RETURN', 'CANDIDATES_UPLOADED', 'BATCH_RESUBMITTED']));
  });

  it('lets an officer withdraw a mistaken vote while the step is open', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    const [dev, meera] = await Promise.all(['dev', 'meera'].map(login));
    await vote(dev, b.id, { decision: 'REJECT', reason: 'clicked wrong button' });
    const w = await api().post(`/api/batches/${b.id}/votes/withdraw`).set('authorization', `Bearer ${dev}`).send({ reason: 'Mistake, meant approve' });
    expect(w.status).toBe(200);
    await vote(dev, b.id, { decision: 'APPROVE' });
    expect((await vote(meera, b.id, { decision: 'APPROVE' })).body.status).toBe('STATE_REVIEW');
    // Once the step is complete, the vote can no longer be withdrawn.
    expect((await api().post(`/api/batches/${b.id}/votes/withdraw`).set('authorization', `Bearer ${dev}`).send({ reason: 'too late' })).status).toBe(409);
  });
});

describe('Never: an untraceable decision', () => {
  it('records who did what and when, and the log cannot be edited', async () => {
    const b = await batchByRef('B-DEMO-SMALL');
    await vote(await login('dev'), b.id, { decision: 'APPROVE' });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.batchId, b.id), eq(auditLog.action, 'VOTE_APPROVE')));
    expect(row!.actorName).toBe('Dev (DISTRICT_OFFICER)');
    expect(row!.at).toBeInstanceOf(Date);
    expect(row!.traceId).not.toBe('untraced');
    await expect(db.update(auditLog).set({ actorName: 'Someone else' }).where(eq(auditLog.id, row!.id))).rejects.toThrow();
    await expect(db.delete(auditLog).where(eq(auditLog.id, row!.id))).rejects.toThrow();
  });
});
