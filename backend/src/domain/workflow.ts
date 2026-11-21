/**
 * The approval workflow as pure functions: no I/O, easy to unit test and to
 * read in one place.
 *
 *  DRAFT ──submit──▶ DISTRICT_REVIEW ──quorum approve──▶ QUALITY_REVIEW (large) ──▶ STATE_REVIEW ──▶ APPROVED ──worker──▶ ISSUED
 *                         │                                 │                         │
 *                         ├─ return (any 1 officer) ────────┴──── return ─────────────┴──▶ RETURNED ──resubmit──▶ DISTRICT_REVIEW (round+1)
 *                         └─ reject (quorum) ───────────────────── reject ───────────────▶ REJECTED (terminal)
 */
import type { BatchStatus, Decision, Role, Stage } from '../db/schema.js';

export interface Actor {
  id: string;
  role: Role;
  displayName: string;
  centreId: string | null;
  districtId: string | null;
}

export interface WorkflowRules {
  districtQuorum: number;
  largeBatchThreshold: number;
}

export const REVIEW_STATUSES: BatchStatus[] = ['DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW'];

export function stageOf(status: BatchStatus): Stage | null {
  switch (status) {
    case 'DISTRICT_REVIEW': return 'DISTRICT';
    case 'QUALITY_REVIEW': return 'QUALITY';
    case 'STATE_REVIEW': return 'STATE';
    default: return null;
  }
}

/** Is this the actor's step? Role AND scope must both match. */
export function canReview(actor: Actor, stage: Stage, batch: { districtId: string }): boolean {
  switch (stage) {
    case 'DISTRICT':
      return actor.role === 'DISTRICT_OFFICER' && actor.districtId === batch.districtId;
    case 'QUALITY':
      return actor.role === 'QUALITY';
    case 'STATE':
      return actor.role === 'STATE';
  }
}

/**
 * How many distinct reviewers must agree for a decision to take effect.
 * District approve/reject need a quorum ("more than one officer must agree").
 * Sending back is cheap to undo (the centre just resubmits) so one officer may
 * do it - otherwise a single obvious error would wait for a second officer.
 */
export function votesNeeded(stage: Stage, decision: Decision, rules: WorkflowRules): number {
  if (stage === 'DISTRICT' && decision !== 'RETURN') return rules.districtQuorum;
  return 1;
}

export function statusAfter(
  stage: Stage, decision: Decision, candidateCount: number, rules: WorkflowRules,
): BatchStatus {
  if (decision === 'REJECT') return 'REJECTED';
  if (decision === 'RETURN') return 'RETURNED';
  switch (stage) {
    case 'DISTRICT':
      return candidateCount >= rules.largeBatchThreshold ? 'QUALITY_REVIEW' : 'STATE_REVIEW';
    case 'QUALITY':
      return 'STATE_REVIEW';
    case 'STATE':
      return 'APPROVED';
  }
}

export function canEditCandidates(status: BatchStatus): boolean {
  return status === 'DRAFT' || status === 'RETURNED';
}

export function canSubmit(status: BatchStatus): boolean {
  return status === 'DRAFT' || status === 'RETURNED';
}
