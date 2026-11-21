import { describe, it, expect } from 'vitest';
import { parseCandidateFile, normalisePhone } from '../src/services/spreadsheet.js';
import { statusAfter, votesNeeded, canReview } from '../src/domain/workflow.js';
import { csv } from './helpers.js';

const rules = { districtQuorum: 2, largeBatchThreshold: 50 };

describe('spreadsheet validation', () => {
  it('reports every bad row with its spreadsheet row number and accepts none of them', async () => {
    const { rows, errors } = await parseCandidateFile(csv([
      ['enrolment_id', 'full_name', 'phone', 'score'],
      ['E-1', 'Asha Rao', '9876543210', '81'],          // row 2 ok
      ['E-2', '=cmd|calc', '9876543211', '70'],    // row 3 formula injection
      ['E-3', 'Ravi Kumar', '12345', '70'],              // row 4 bad phone
      ['E-4', 'Sita Devi', '9876543213', '22'],          // row 5 below pass mark
      ['E-1', 'Dup Person', '9876543214', '90'],         // row 6 duplicate id
      ['E-6', 'Om Prakash', '+91 98765-43215', 'abc'],   // row 7 bad score
    ]), 'batch.csv');
    expect(rows.map((r) => r.rowNumber)).toEqual([2]);
    expect(errors.map((e) => [e.row, e.field])).toEqual([
      [3, 'fullName'], [4, 'phone'], [5, 'score'], [6, 'enrolmentId'], [7, 'score'],
    ]);
    expect(errors.find((e) => e.row === 6)!.message).toMatch(/first seen on row 2/);
  });

  it('rejects files with missing columns or unsupported types', async () => {
    expect((await parseCandidateFile(csv([['name', 'phone'], ['A', '9876543210']]), 'x.csv')).errors[0]!.message).toMatch(/Missing column/);
    expect((await parseCandidateFile(Buffer.from('hi'), 'x.pdf')).errors[0]!.message).toMatch(/Only .csv and .xlsx/);
  });

  it('normalises Indian mobile numbers', () => {
    expect(normalisePhone('098765 43210')).toBe('+919876543210');
    expect(normalisePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalisePhone('5876543210')).toBeNull();
  });
});

describe('workflow rules', () => {
  it('needs a district quorum to approve or reject, one officer to send back', () => {
    expect(votesNeeded('DISTRICT', 'APPROVE', rules)).toBe(2);
    expect(votesNeeded('DISTRICT', 'REJECT', rules)).toBe(2);
    expect(votesNeeded('DISTRICT', 'RETURN', rules)).toBe(1);
    expect(votesNeeded('STATE', 'APPROVE', rules)).toBe(1);
  });

  it('routes large batches through the quality team', () => {
    expect(statusAfter('DISTRICT', 'APPROVE', 49, rules)).toBe('STATE_REVIEW');
    expect(statusAfter('DISTRICT', 'APPROVE', 50, rules)).toBe('QUALITY_REVIEW');
    expect(statusAfter('QUALITY', 'APPROVE', 60, rules)).toBe('STATE_REVIEW');
    expect(statusAfter('STATE', 'APPROVE', 60, rules)).toBe('APPROVED');
  });

  it('only lets officers of the batch district act at the district step', () => {
    const batch = { districtId: 'north' };
    const officer = { id: '1', role: 'DISTRICT_OFFICER' as const, displayName: 'x', centreId: null, districtId: 'north' };
    expect(canReview(officer, 'DISTRICT', batch)).toBe(true);
    expect(canReview({ ...officer, districtId: 'south' }, 'DISTRICT', batch)).toBe(false);
    expect(canReview(officer, 'STATE', batch)).toBe(false);
    expect(canReview({ ...officer, role: 'STATE' }, 'DISTRICT', batch)).toBe(false);
  });
});
