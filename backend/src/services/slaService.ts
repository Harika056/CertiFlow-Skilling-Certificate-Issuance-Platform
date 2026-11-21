import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { batches, centres, deliveries, certificates, escalations } from '../db/schema.js';
import { config } from '../config.js';
import type { Actor } from '../domain/workflow.js';
import { REVIEW_STATUSES } from '../domain/workflow.js';
import { forbidden } from '../lib/errors.js';
import { audit, emit } from './events.js';
import { scopeOf } from './batchService.js';

/**
 * Finds batches that have waited at one step longer than the SLA and raises
 * an escalation to the state office. The unique index on
 * (batch, round, status) means each wait is escalated once, even with many
 * workers scanning at the same time.
 */
export async function escalateStuckBatches(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.slaMinutes * 60_000);
  return db.transaction(async (tx) => {
    const stuck = await tx.select().from(batches)
      .where(and(inArray(batches.status, REVIEW_STATUSES), lt(batches.stageEnteredAt, cutoff)));
    let raised = 0;
    for (const b of stuck) {
      const [esc] = await tx.insert(escalations).values({
        batchId: b.id, round: b.round, status: b.status, waitingSince: b.stageEnteredAt,
      }).onConflictDoNothing().returning();
      if (!esc) continue;
      raised++;
      const hours = Math.round((now.getTime() - b.stageEnteredAt.getTime()) / 36e5 * 10) / 10;
      await audit(tx, null, 'BATCH_ESCALATED', { type: 'batch', id: b.id, batchId: b.id },
        { status: b.status, waitingHours: hours, slaMinutes: config.slaMinutes });
      await emit(tx, { type: 'BatchEscalated', aggregateId: b.id, scope: scopeOf(b), data: { status: b.status, hours } });
    }
    return { raised };
  });
}

/** State office "what is stuck" view. */
export async function stuckOverview(actor: Actor) {
  if (actor.role !== 'STATE') throw forbidden();
  const waiting = await db.select({
    id: batches.id, reference: batches.reference, title: batches.title, status: batches.status,
    stageEnteredAt: batches.stageEnteredAt, centreName: centres.name, round: batches.round,
    escalatedAt: escalations.escalatedAt,
    waitingMinutes: sql<number>`floor(extract(epoch from (now() - ${batches.stageEnteredAt})) / 60)::int`,
  }).from(batches)
    .innerJoin(centres, eq(centres.id, batches.centreId))
    .leftJoin(escalations, and(eq(escalations.batchId, batches.id), eq(escalations.round, batches.round), eq(escalations.status, batches.status)))
    .where(inArray(batches.status, REVIEW_STATUSES))
    .orderBy(asc(batches.stageEnteredAt));

  const failedDeliveries = await db.select({
    certificateId: certificates.id, certNumber: certificates.certNumber, holderName: certificates.holderName,
    attempts: deliveries.attempts, lastError: deliveries.lastError, batchId: certificates.batchId,
  }).from(deliveries).innerJoin(certificates, eq(certificates.id, deliveries.certificateId))
    .where(eq(deliveries.status, 'FAILED')).limit(200);

  return { slaMinutes: config.slaMinutes, waiting, failedDeliveries };
}
