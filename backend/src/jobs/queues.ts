import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import type { EventType } from '../services/events.js';

/**
 * One queue per kind of slow work, so a WhatsApp outage (thousands of
 * retrying jobs) never delays issuing certificates or making PDFs.
 */
export const QUEUES = {
  issuance: 'issuance',   // BatchApproved      -> create certificate rows
  pdf: 'pdf',             // CertificateIssued  -> render PDF
  whatsapp: 'whatsapp',   // CertificatePdfReady-> send to candidate
  maintenance: 'maintenance', // repeatable SLA scan
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ROUTES: Partial<Record<EventType, QueueName>> = {
  BatchApproved: 'issuance',
  CertificateIssued: 'pdf',
  CertificatePdfReady: 'whatsapp',
};

export const REALTIME_CHANNEL = 'certiflow:events';

export function jobOptions(queue: QueueName): JobsOptions {
  const keep = { removeOnComplete: { age: 24 * 3600, count: 50_000 }, removeOnFail: { age: 7 * 24 * 3600 } };
  if (queue === 'whatsapp') {
    return { ...keep, attempts: config.whatsappMaxAttempts, backoff: { type: 'exponential', delay: config.whatsappBackoffMs } };
  }
  return { ...keep, attempts: 10, backoff: { type: 'exponential', delay: 1000 } };
}

export interface EventJob {
  eventId: number;
  type: EventType;
  aggregateId: string;
  traceId: string;
  payload: { scope: Record<string, string>; data: Record<string, unknown> };
}

export function createQueues(connection: Redis) {
  return Object.fromEntries(
    Object.values(QUEUES).map((n) => [n, new Queue(n, { connection, prefix: 'cf' })]),
  ) as Record<QueueName, Queue>;
}
