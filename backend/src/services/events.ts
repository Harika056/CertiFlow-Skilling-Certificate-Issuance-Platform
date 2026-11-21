import type { DbOrTx } from '../db/client.js';
import { auditLog, outbox } from '../db/schema.js';
import { currentTraceId } from '../lib/trace.js';
import type { Actor } from '../domain/workflow.js';

/** Event names flowing through the outbox -> queue. */
export type EventType =
  | 'BatchSubmitted'
  | 'BatchVoteCast'
  | 'BatchVoteWithdrawn'
  | 'BatchStageChanged'
  | 'BatchApproved'
  | 'BatchIssued'
  | 'CertificateIssued'
  | 'CertificatePdfReady'
  | 'CertificateDelivered'
  | 'CertificateDeliveryFailed'
  | 'CertificateRevoked'
  | 'BatchEscalated'
  | 'BatchUpdated';

export interface DomainEvent {
  type: EventType;
  aggregateId: string;
  /** For realtime fan-out filtering: who may hear about this. */
  scope: { batchId?: string; centreId?: string; districtId?: string };
  data?: Record<string, unknown>;
}

/** Write an event in the SAME transaction as the state change it describes. */
export async function emit(tx: DbOrTx, event: DomainEvent) {
  await tx.insert(outbox).values({
    type: event.type,
    aggregateId: event.aggregateId,
    payload: { scope: event.scope, data: event.data ?? {} },
    traceId: currentTraceId(),
  });
}

export async function audit(
  tx: DbOrTx,
  actor: Actor | null,
  action: string,
  entity: { type: string; id: string; batchId?: string | null },
  details: Record<string, unknown> = {},
) {
  await tx.insert(auditLog).values({
    actorId: actor?.id ?? null,
    actorName: actor ? `${actor.displayName} (${actor.role})` : 'system',
    action,
    entityType: entity.type,
    entityId: entity.id,
    batchId: entity.batchId ?? null,
    details,
    traceId: currentTraceId(),
  });
}
