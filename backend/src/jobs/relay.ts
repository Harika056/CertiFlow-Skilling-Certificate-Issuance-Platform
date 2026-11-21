/**
 * Outbox relay: moves committed events from Postgres onto the queues and the
 * realtime channel.
 *
 * Crash safety: rows are only marked published after the queue accepted the
 * job. If we crash in between, the row is picked up again and re-added with
 * the SAME jobId (evt-<id>-<aggregate>), which BullMQ de-duplicates; handlers are also
 * idempotent, so a duplicate can never cause a second certificate or message.
 * FOR UPDATE SKIP LOCKED lets several relays run side by side.
 */
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { jobOptions, REALTIME_CHANNEL, ROUTES, type EventJob, type QueueName } from './queues.js';

interface OutboxRow { id: string | number; type: string; aggregate_id: string; payload: EventJob['payload']; trace_id: string }

export async function relayOnce(queues: Record<QueueName, Queue>, publisher: Redis, batchSize = 200): Promise<number> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, type, aggregate_id, payload, trace_id FROM outbox
      WHERE published_at IS NULL ORDER BY id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`);
    const rows = res.rows as unknown as OutboxRow[];
    if (rows.length === 0) return 0;

    for (const r of rows) {
      const job: EventJob = {
        eventId: Number(r.id), type: r.type as EventJob['type'], aggregateId: r.aggregate_id,
        traceId: r.trace_id, payload: r.payload,
      };
      const queue = ROUTES[job.type];
      if (queue) {
        await queues[queue].add(job.type, job, { ...jobOptions(queue), jobId: `evt-${job.eventId}-${job.aggregateId}` });
      }
      // Realtime is best effort: a missed UI ping is fixed by the next refresh.
      publisher.publish(REALTIME_CHANNEL, JSON.stringify({
        type: job.type, aggregateId: job.aggregateId, scope: job.payload.scope, at: new Date().toISOString(),
      })).catch((err) => logger.warn({ err }, 'realtime publish failed'));
    }
    const ids = rows.map((r) => Number(r.id));
    await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    return rows.length;
  });
}
