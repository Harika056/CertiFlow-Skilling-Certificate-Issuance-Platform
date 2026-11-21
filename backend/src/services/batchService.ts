import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, type Tx } from '../db/client.js';
import {
  batches, candidates, centres, certificates, deliveries, reviewVotes, users,
  type BatchStatus, type Decision,
} from '../db/schema.js';
import { config } from '../config.js';
import {
  type Actor, canEditCandidates, canReview, canSubmit, stageOf, statusAfter, votesNeeded, REVIEW_STATUSES,
} from '../domain/workflow.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors.js';
import { audit, emit } from './events.js';
import { parseCandidateFile, type RowError } from './spreadsheet.js';

const rules = () => ({ districtQuorum: config.districtQuorum, largeBatchThreshold: config.largeBatchThreshold });

type BatchRow = typeof batches.$inferSelect;

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// ---------------------------------------------------------------- visibility

/** Who may SEE a batch. Drafts are private to their centre. */
export function canSeeBatch(actor: Actor, batch: Pick<BatchRow, 'centreId' | 'districtId' | 'status'>): boolean {
  switch (actor.role) {
    case 'CENTRE': return actor.centreId === batch.centreId;
    case 'DISTRICT_OFFICER': return actor.districtId === batch.districtId && batch.status !== 'DRAFT';
    case 'QUALITY':
    case 'STATE': return batch.status !== 'DRAFT';
  }
}

function visibilityFilter(actor: Actor): SQL {
  switch (actor.role) {
    case 'CENTRE': return eq(batches.centreId, actor.centreId ?? '00000000-0000-0000-0000-000000000000');
    case 'DISTRICT_OFFICER': return and(eq(batches.districtId, actor.districtId ?? '00000000-0000-0000-0000-000000000000'), ne(batches.status, 'DRAFT'))!;
    default: return ne(batches.status, 'DRAFT');
  }
}

/** Load + lock a batch row for the rest of the transaction. Serialises concurrent decisions. */
async function lockBatch(tx: Tx, actor: Actor, batchId: string): Promise<BatchRow> {
  const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
  // Same answer for "missing" and "not yours": never confirm another centre's batch exists.
  if (!batch || !canSeeBatch(actor, batch)) throw notFound('Batch not found');
  return batch;
}

function maskPhone(phone: string) {
  return phone.slice(0, 3) + '******' + phone.slice(-2);
}

// ---------------------------------------------------------------- queries

export async function listBatches(actor: Actor, opts: { inbox?: boolean; status?: BatchStatus } = {}) {
  const conds: SQL[] = [visibilityFilter(actor)];
  if (opts.status) conds.push(eq(batches.status, opts.status));
  if (opts.inbox) {
    const awaiting: Record<string, BatchStatus[]> = {
      CENTRE: ['DRAFT', 'RETURNED'], DISTRICT_OFFICER: ['DISTRICT_REVIEW'], QUALITY: ['QUALITY_REVIEW'], STATE: ['STATE_REVIEW'],
    };
    conds.push(inArray(batches.status, awaiting[actor.role]!));
  }
  const rows = await db
    .select({
      id: batches.id, reference: batches.reference, title: batches.title, course: batches.course,
      status: batches.status, round: batches.round, candidateCount: batches.candidateCount,
      stageEnteredAt: batches.stageEnteredAt, updatedAt: batches.updatedAt, lastReason: batches.lastReason,
      centreName: centres.name, centreId: batches.centreId, districtId: batches.districtId,
      // Has the current user already cast an active vote in this round/stage?
      myVote: sql<string | null>`(
        SELECT v.decision FROM review_votes v
        WHERE v.batch_id = ${batches.id} AND v.round = ${batches.round} AND v.actor_id = ${actor.id}
          AND v.withdrawn_at IS NULL
          AND v.stage::text = CASE ${batches.status}::text
            WHEN 'DISTRICT_REVIEW' THEN 'DISTRICT' WHEN 'QUALITY_REVIEW' THEN 'QUALITY' WHEN 'STATE_REVIEW' THEN 'STATE' END
        LIMIT 1)`,
      approvals: sql<number>`(
        SELECT count(*)::int FROM review_votes v
        WHERE v.batch_id = ${batches.id} AND v.round = ${batches.round} AND v.withdrawn_at IS NULL
          AND v.decision = 'APPROVE' AND v.stage = 'DISTRICT')`,
      escalated: sql<boolean>`EXISTS (SELECT 1 FROM escalations e WHERE e.batch_id = ${batches.id}
          AND e.round = ${batches.round} AND e.status = ${batches.status})`,
    })
    .from(batches)
    .innerJoin(centres, eq(centres.id, batches.centreId))
    .where(and(...conds))
    .orderBy(desc(batches.updatedAt))
    .limit(200);
  return rows;
}

export async function getBatch(actor: Actor, batchId: string) {
  const [row] = await db
    .select({ batch: batches, centreName: centres.name })
    .from(batches).innerJoin(centres, eq(centres.id, batches.centreId))
    .where(eq(batches.id, batchId));
  if (!row || !canSeeBatch(actor, row.batch)) throw notFound('Batch not found');
  const { batch } = row;

  const cands = await db.select().from(candidates).where(eq(candidates.batchId, batchId)).orderBy(asc(candidates.rowNumber));
  const votes = await db
    .select({
      id: reviewVotes.id, round: reviewVotes.round, stage: reviewVotes.stage, decision: reviewVotes.decision,
      reason: reviewVotes.reason, createdAt: reviewVotes.createdAt, withdrawnAt: reviewVotes.withdrawnAt,
      withdrawReason: reviewVotes.withdrawReason, actorId: reviewVotes.actorId, actorName: users.displayName,
    })
    .from(reviewVotes).innerJoin(users, eq(users.id, reviewVotes.actorId))
    .where(eq(reviewVotes.batchId, batchId)).orderBy(asc(reviewVotes.createdAt));

  const certs = await db
    .select({
      id: certificates.id, candidateId: certificates.candidateId, certNumber: certificates.certNumber,
      status: certificates.status, pdfStatus: certificates.pdfStatus,
      delivery: deliveries.status, attempts: deliveries.attempts,
    })
    .from(certificates).leftJoin(deliveries, eq(deliveries.certificateId, certificates.id))
    .where(eq(certificates.batchId, batchId));
  const certByCandidate = new Map(certs.map((c) => [c.candidateId, c]));

  // Phone numbers are personal data: only the owning centre sees them in full.
  const showPhone = actor.role === 'CENTRE';
  const stage = stageOf(batch.status);
  return {
    ...batch,
    centreName: row.centreName,
    stage,
    canAct: stage ? canReview(actor, stage, batch) : false,
    rules: { districtQuorum: config.districtQuorum, largeBatchThreshold: config.largeBatchThreshold },
    candidates: cands.map((c) => ({
      id: c.id, rowNumber: c.rowNumber, enrolmentId: c.enrolmentId, fullName: c.fullName,
      phone: showPhone ? c.phone : maskPhone(c.phone), score: c.score,
      certificate: certByCandidate.get(c.id) ?? null,
    })),
    votes,
  };
}

// ---------------------------------------------------------------- centre actions

export async function createBatch(actor: Actor, input: { title: string; course: string }) {
  if (actor.role !== 'CENTRE' || !actor.centreId) throw forbidden('Only a training centre can create batches');
  const [centre] = await db.select().from(centres).where(eq(centres.id, actor.centreId));
  if (!centre) throw forbidden('Your account is not linked to a centre');

  return db.transaction(async (tx) => {
    const reference = `B-${new Date().getFullYear()}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const [batch] = await tx.insert(batches).values({
      reference, title: input.title, course: input.course,
      centreId: centre.id, districtId: centre.districtId, createdBy: actor.id,
    }).returning();
    await audit(tx, actor, 'BATCH_CREATED', { type: 'batch', id: batch!.id, batchId: batch!.id }, { reference, course: input.course });
    await emit(tx, { type: 'BatchUpdated', aggregateId: batch!.id, scope: scopeOf(batch!) });
    return batch!;
  });
}

export async function uploadCandidates(actor: Actor, batchId: string, file: { buffer: Buffer; originalname: string }) {
  if (actor.role !== 'CENTRE') throw forbidden('Only the owning centre can upload candidates');

  // 1. Parse + validate the whole file in memory. Nothing touches the DB yet.
  const { rows, errors } = await parseCandidateFile(file.buffer, file.originalname);
  if (rows.length > config.maxBatchSize) {
    errors.push({ row: 0, field: 'file', message: `A batch can have at most ${config.maxBatchSize} candidates` });
  }

  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, actor, batchId);
    if (!canEditCandidates(batch.status)) {
      throw conflict(`Candidates can only be changed while the batch is DRAFT or RETURNED (it is ${batch.status})`);
    }

    // 2. Cross-check against already-issued certificates (no double certification).
    if (rows.length) {
      const [centre] = await tx.select().from(centres).where(eq(centres.id, batch.centreId));
      const keys = rows.map((r) => enrolmentKey(centre!.code, r.enrolmentId, batch.course));
      const existing = await tx.select({ key: certificates.enrolmentKey, num: certificates.certNumber })
        .from(certificates).where(inArray(certificates.enrolmentKey, keys));
      const byKey = new Map(existing.map((e) => [e.key, e.num]));
      for (const r of rows) {
        const num = byKey.get(enrolmentKey(centre!.code, r.enrolmentId, batch.course));
        if (num) errors.push({ row: r.rowNumber, field: 'enrolmentId', value: r.enrolmentId, message: `already certified for ${batch.course} (certificate ${num})` });
      }
    }

    if (errors.length) {
      errors.sort((a, b) => a.row - b.row);
      // Throwing rolls back the transaction: nothing half-saved.
      throw unprocessable(`The file has ${errors.length} problem(s). Nothing was saved - fix them and upload again.`, { errors });
    }

    // 3. Replace the candidate list atomically.
    await tx.delete(candidates).where(eq(candidates.batchId, batch.id));
    await tx.insert(candidates).values(rows.map((r) => ({
      batchId: batch.id, enrolmentId: r.enrolmentId, fullName: r.fullName, phone: r.phone, score: String(r.score), rowNumber: r.rowNumber,
    })));
    await tx.update(batches).set({ candidateCount: rows.length, updatedAt: new Date() }).where(eq(batches.id, batch.id));
    await audit(tx, actor, 'CANDIDATES_UPLOADED', { type: 'batch', id: batch.id, batchId: batch.id },
      { file: file.originalname, count: rows.length, replacedPrevious: batch.candidateCount });
    await emit(tx, { type: 'BatchUpdated', aggregateId: batch.id, scope: scopeOf(batch) });
    return { accepted: rows.length };
  });
}

export function enrolmentKey(centreCode: string, enrolmentId: string, course: string) {
  return `${centreCode}:${enrolmentId.toUpperCase()}:${course.trim().toUpperCase()}`;
}

export async function submitBatch(actor: Actor, batchId: string) {
  if (actor.role !== 'CENTRE') throw forbidden('Only the owning centre can submit a batch');
  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, actor, batchId);
    if (!canSubmit(batch.status)) throw conflict(`A ${batch.status} batch cannot be submitted`);
    if (batch.candidateCount === 0) throw badRequest('Add candidates before submitting');

    const round = batch.round + 1;
    const [updated] = await tx.update(batches)
      .set({ status: 'DISTRICT_REVIEW', round, stageEnteredAt: new Date(), updatedAt: new Date() })
      .where(eq(batches.id, batch.id)).returning();
    await audit(tx, actor, batch.status === 'RETURNED' ? 'BATCH_RESUBMITTED' : 'BATCH_SUBMITTED',
      { type: 'batch', id: batch.id, batchId: batch.id },
      { round, previousStatus: batch.status, note: round > 1 ? 'New review round: approvals from earlier rounds no longer count' : undefined });
    await emit(tx, { type: 'BatchSubmitted', aggregateId: batch.id, scope: scopeOf(batch), data: { round } });
    return updated!;
  });
}

// ---------------------------------------------------------------- reviewer actions

export async function castVote(
  actor: Actor, batchId: string,
  input: { decision: Decision; reason?: string; expectedRound?: number },
) {
  const reason = input.reason?.trim();
  if ((input.decision === 'REJECT' || input.decision === 'RETURN') && !reason) {
    throw badRequest('A reason is required to reject or send back a batch');
  }

  return db.transaction(async (tx) => {
    // Row lock: concurrent votes on the same batch are processed one at a time,
    // so the quorum is counted exactly once and the batch moves exactly once.
    const batch = await lockBatch(tx, actor, batchId);
    const stage = stageOf(batch.status);
    if (!stage) throw conflict(`This batch is ${batch.status} and is not awaiting review`);
    if (!canReview(actor, stage, batch)) {
      // A legitimate reviewer who was simply too late gets a clear 409, not a 403.
      const own = ownStage(actor);
      const order = { DISTRICT: 0, QUALITY: 1, STATE: 2 } as const;
      if (own && order[own] < order[stage] && canReview(actor, own, batch)) {
        throw conflict(`This batch has already moved on to ${batch.status}; your step is complete`);
      }
      throw forbidden(`The ${stage} review step is not yours`);
    }
    if (input.expectedRound !== undefined && input.expectedRound !== batch.round) {
      throw conflict('The batch was resubmitted since you opened it. Please review the latest version.');
    }

    try {
      // Savepoint so a unique violation doesn't poison the outer transaction.
      await tx.transaction(async (sp) => {
        await sp.insert(reviewVotes).values({
          batchId: batch.id, round: batch.round, stage, actorId: actor.id, decision: input.decision, reason,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('You have already recorded a decision on this batch. Withdraw it first to change it.');
      throw err;
    }
    await audit(tx, actor, `VOTE_${input.decision}`, { type: 'batch', id: batch.id, batchId: batch.id },
      { stage, round: batch.round, reason });

    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(DISTINCT ${reviewVotes.actorId})::int` })
      .from(reviewVotes)
      .where(and(
        eq(reviewVotes.batchId, batch.id), eq(reviewVotes.round, batch.round), eq(reviewVotes.stage, stage),
        eq(reviewVotes.decision, input.decision), isNull(reviewVotes.withdrawnAt),
      ));

    const needed = votesNeeded(stage, input.decision, rules());
    if (count < needed) {
      await emit(tx, { type: 'BatchVoteCast', aggregateId: batch.id, scope: scopeOf(batch), data: { stage, decision: input.decision, count, needed } });
      return { batchId: batch.id, status: batch.status, moved: false, votes: count, needed };
    }

    const next = statusAfter(stage, input.decision, batch.candidateCount, rules());
    await tx.update(batches).set({
      status: next, stageEnteredAt: new Date(), updatedAt: new Date(),
      lastReason: input.decision === 'APPROVE' ? batch.lastReason : reason,
    }).where(eq(batches.id, batch.id));
    await audit(tx, null, 'BATCH_STAGE_CHANGED', { type: 'batch', id: batch.id, batchId: batch.id },
      { from: batch.status, to: next, decidedBy: actor.displayName, votes: count, needed, round: batch.round });
    await emit(tx, { type: 'BatchStageChanged', aggregateId: batch.id, scope: scopeOf(batch), data: { from: batch.status, to: next } });
    if (next === 'APPROVED') {
      // The slow part (PDFs, WhatsApp) happens in the worker, never in this request.
      await emit(tx, { type: 'BatchApproved', aggregateId: batch.id, scope: scopeOf(batch) });
    }
    return { batchId: batch.id, status: next, moved: true, votes: count, needed };
  });
}

/**
 * "Officers sometimes make mistakes": an officer may withdraw their own vote
 * while the stage is still open. Once a stage has completed the decision has
 * taken effect; correcting it then is a state-office "send back".
 */
export async function withdrawVote(actor: Actor, batchId: string, reason: string) {
  if (!reason?.trim()) throw badRequest('Say why you are withdrawing your decision');
  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, actor, batchId);
    const stage = stageOf(batch.status);
    const [vote] = stage ? await tx.select().from(reviewVotes).where(and(
      eq(reviewVotes.batchId, batch.id), eq(reviewVotes.round, batch.round), eq(reviewVotes.stage, stage),
      eq(reviewVotes.actorId, actor.id), isNull(reviewVotes.withdrawnAt),
    )) : [];
    if (!vote) throw conflict('You have no open decision on this batch at its current step. If the step has already completed, ask the state office to send it back.');

    await tx.update(reviewVotes).set({ withdrawnAt: new Date(), withdrawReason: reason.trim() }).where(eq(reviewVotes.id, vote.id));
    await audit(tx, actor, 'VOTE_WITHDRAWN', { type: 'batch', id: batch.id, batchId: batch.id },
      { stage, round: batch.round, withdrawnDecision: vote.decision, reason: reason.trim() });
    await emit(tx, { type: 'BatchVoteWithdrawn', aggregateId: batch.id, scope: scopeOf(batch) });
    return { withdrawn: vote.decision };
  });
}

function ownStage(actor: Actor) {
  return ({ DISTRICT_OFFICER: 'DISTRICT', QUALITY: 'QUALITY', STATE: 'STATE' } as const)[actor.role as 'STATE'] ?? null;
}

export function scopeOf(b: Pick<BatchRow, 'id' | 'centreId' | 'districtId'>) {
  return { batchId: b.id, centreId: b.centreId, districtId: b.districtId };
}

export { REVIEW_STATUSES };
export type { RowError };
