import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, integer, timestamp, jsonb, bigserial,
  uniqueIndex, index, numeric, pgSequence,
} from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['CENTRE', 'DISTRICT_OFFICER', 'QUALITY', 'STATE']);

/**
 * Batch lifecycle. See src/domain/workflow.ts for the allowed transitions.
 */
export const batchStatusEnum = pgEnum('batch_status', [
  'DRAFT',            // centre is still editing
  'DISTRICT_REVIEW',  // waiting for >= DISTRICT_QUORUM officers of the district
  'QUALITY_REVIEW',   // only for large batches
  'STATE_REVIEW',     // final say
  'RETURNED',         // sent back to the centre with a reason; centre fixes + resubmits
  'REJECTED',         // terminal
  'APPROVED',         // state approved; issuance in progress (async)
  'ISSUED',           // certificates created for every candidate
]);

export const stageEnum = pgEnum('review_stage', ['DISTRICT', 'QUALITY', 'STATE']);
export const decisionEnum = pgEnum('decision', ['APPROVE', 'REJECT', 'RETURN']);
export const certStatusEnum = pgEnum('certificate_status', ['VALID', 'REVOKED']);
export const pdfStatusEnum = pgEnum('pdf_status', ['PENDING', 'READY']);
export const deliveryStatusEnum = pgEnum('delivery_status', ['PENDING', 'SENDING', 'SENT', 'FAILED']);

export const districts = pgTable('districts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
});

export const centres = pgTable('centres', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  districtId: uuid('district_id').notNull().references(() => districts.id),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: roleEnum('role').notNull(),
  // Scope: a centre user belongs to a centre; an officer to a district.
  centreId: uuid('centre_id').references(() => centres.id),
  districtId: uuid('district_id').references(() => districts.id),
  active: integer('active').notNull().default(1),
});

export const batches = pgTable('batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  reference: text('reference').notNull().unique(),
  title: text('title').notNull(),
  course: text('course').notNull(),
  centreId: uuid('centre_id').notNull().references(() => centres.id),
  districtId: uuid('district_id').notNull().references(() => districts.id),
  status: batchStatusEnum('status').notNull().default('DRAFT'),
  // Each submission is a new review round. Votes belong to a round, so a
  // resubmitted batch starts from zero approvals (see README decision D4).
  round: integer('round').notNull().default(0),
  candidateCount: integer('candidate_count').notNull().default(0),
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
  lastReason: text('last_reason'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('batches_status_idx').on(t.status, t.stageEnteredAt),
  index('batches_district_idx').on(t.districtId, t.status),
]);

export const candidates = pgTable('candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => batches.id, { onDelete: 'cascade' }),
  enrolmentId: text('enrolment_id').notNull(),
  fullName: text('full_name').notNull(),
  phone: text('phone').notNull(),           // E.164, e.g. +919876543210
  score: numeric('score', { precision: 5, scale: 2 }).notNull(),
  rowNumber: integer('row_number').notNull(),
}, (t) => [
  uniqueIndex('candidates_batch_enrolment_uq').on(t.batchId, t.enrolmentId),
]);

/**
 * One row per vote. Partial unique index guarantees one *active* vote per
 * officer per stage per round, so a double click or a replayed request can
 * never count twice.
 */
export const reviewVotes = pgTable('review_votes', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => batches.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  stage: stageEnum('stage').notNull(),
  actorId: uuid('actor_id').notNull().references(() => users.id),
  decision: decisionEnum('decision').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawReason: text('withdraw_reason'),
}, (t) => [
  uniqueIndex('review_votes_active_uq')
    .on(t.batchId, t.round, t.stage, t.actorId)
    .where(sql`withdrawn_at IS NULL`),
]);

export const certificates = pgTable('certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  certNumber: text('cert_number').notNull().unique(),
  // Random, unguessable code printed on the certificate / QR. Public lookups
  // use this, never the sequential number, so certificates cannot be enumerated.
  verificationCode: text('verification_code').notNull().unique(),
  candidateId: uuid('candidate_id').notNull().unique().references(() => candidates.id),
  // centre + enrolment + course: the same person cannot be certified twice for
  // the same course even through a second batch.
  enrolmentKey: text('enrolment_key').notNull().unique(),
  batchId: uuid('batch_id').notNull().references(() => batches.id),
  holderName: text('holder_name').notNull(),
  course: text('course').notNull(),
  centreName: text('centre_name').notNull(),
  status: certStatusEnum('status').notNull().default('VALID'),
  pdfStatus: pdfStatusEnum('pdf_status').notNull().default('PENDING'),
  pdfPath: text('pdf_path'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id),
  revokeReason: text('revoke_reason'),
}, (t) => [index('certificates_batch_idx').on(t.batchId)]);

export const deliveries = pgTable('deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  certificateId: uuid('certificate_id').notNull().unique().references(() => certificates.id),
  phone: text('phone').notNull(),
  status: deliveryStatusEnum('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  providerMessageId: text('provider_message_id'),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Transactional outbox. Domain changes and the events describing them are
 * committed together; the relay (worker) publishes them to the queue.
 */
export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  type: text('type').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  payload: jsonb('payload').notNull(),
  traceId: text('trace_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => [index('outbox_unpublished_idx').on(t.id).where(sql`published_at IS NULL`)]);

/** Append-only audit trail: who did what, when, under which trace id. */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorId: uuid('actor_id').references(() => users.id),   // null = system
  actorName: text('actor_name').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  batchId: uuid('batch_id'),
  details: jsonb('details').notNull().default({}),
  traceId: text('trace_id').notNull(),
}, (t) => [
  index('audit_batch_idx').on(t.batchId, t.id),
  index('audit_entity_idx').on(t.entityType, t.entityId),
]);

export const escalations = pgTable('escalations', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => batches.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  status: batchStatusEnum('status').notNull(),
  waitingSince: timestamp('waiting_since', { withTimezone: true }).notNull(),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedBy: uuid('acknowledged_by').references(() => users.id),
}, (t) => [uniqueIndex('escalations_once_uq').on(t.batchId, t.round, t.status)]);

// Postgres sequence => certificate numbers are unique even across many workers.
export const certNumberSeq = pgSequence('certificate_number_seq', { startWith: 1, increment: 1 });
export type BatchStatus = (typeof batchStatusEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type Stage = (typeof stageEnum.enumValues)[number];
export type Decision = (typeof decisionEnum.enumValues)[number];
