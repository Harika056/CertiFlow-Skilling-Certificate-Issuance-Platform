import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { runWithTrace } from '../lib/trace.js';
import { generatePdf, issueBatch } from '../services/certificateService.js';
import { deliverCertificate, markDeliveryFailed } from '../services/deliveryService.js';
import { escalateStuckBatches } from '../services/slaService.js';
import { createQueues, QUEUES, type EventJob, type QueueName } from './queues.js';
import { relayOnce } from './relay.js';

type Handler = (job: Job<EventJob>) => Promise<unknown>;

const handlers: Record<Exclude<QueueName, 'maintenance'>, Handler> = {
  issuance: (job) => issueBatch(job.data.aggregateId),
  pdf: (job) => generatePdf(job.data.aggregateId),
  whatsapp: (job) => deliverCertificate(job.data.aggregateId),
};

const concurrency: Record<QueueName, number> = { issuance: 2, pdf: 4, whatsapp: 10, maintenance: 1 };

/**
 * Starts the relay loop, the queue consumers and the SLA scheduler.
 * Every instance of the worker container runs this; they coordinate only
 * through Postgres row locks and Redis, so you can run as many as you like.
 */
export async function startWorkers(connection: Redis, publisher: Redis, opts: { relay?: boolean; sla?: boolean } = {}) {
  const queues = createQueues(connection);
  const workers: Worker[] = [];

  for (const name of ['issuance', 'pdf', 'whatsapp'] as const) {
    const w = new Worker<EventJob>(name, async (job) => runWithTrace(job.data.traceId, async () => {
      const log = logger.child({ queue: name, jobId: job.id, traceId: job.data.traceId, aggregateId: job.data.aggregateId, attempt: job.attemptsMade + 1 });
      log.info('job start');
      const result = await handlers[name](job);
      log.info({ result }, 'job done');
      return result;
    }), {
      connection, prefix: 'cf', concurrency: concurrency[name],
      ...(name === 'whatsapp' ? { limiter: { max: config.whatsappRatePerSec, duration: 1000 } } : {}),
    });

    w.on('failed', (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      logger.warn({ queue: name, jobId: job.id, traceId: job.data.traceId, err: err.message, attempt: job.attemptsMade, final }, 'job failed');
      if (final && name === 'whatsapp') {
        runWithTrace(job.data.traceId, () => markDeliveryFailed(job.data.aggregateId, err.message))
          .catch((e) => logger.error({ e }, 'could not mark delivery failed'));
      }
    });
    workers.push(w);
  }

  // SLA scan as a repeatable job: exactly one run per interval across all workers.
  const maint = new Worker(QUEUES.maintenance, async () => escalateStuckBatches(), { connection, prefix: 'cf' });
  workers.push(maint);
  if (opts.sla !== false) {
    await queues.maintenance.upsertJobScheduler('sla-scan', { every: config.slaScanIntervalMs }, { name: 'sla-scan' });
  }

  let stopped = false;
  let relayTimer: NodeJS.Timeout | undefined;
  const loop = async () => {
    if (stopped) return;
    try {
      const n = await relayOnce(queues, publisher);
      relayTimer = setTimeout(loop, n > 0 ? 0 : config.outboxPollMs);
    } catch (err) {
      logger.error({ err }, 'relay error; retrying');
      relayTimer = setTimeout(loop, 1000);
    }
  };
  if (opts.relay !== false) loop();

  return {
    queues,
    async close() {
      stopped = true;
      if (relayTimer) clearTimeout(relayTimer);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
    },
  };
}
