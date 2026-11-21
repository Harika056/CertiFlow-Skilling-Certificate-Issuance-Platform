/**
 * Parses the spreadsheet a centre already keeps (CSV or XLSX) and validates
 * EVERY row before anything is saved. Either the whole file is accepted or the
 * centre gets the full list of problems and nothing is written.
 */
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';

export const PASS_MARK = 40;
const MAX_FILE_ROWS = 1000;

export interface CandidateRow {
  rowNumber: number;
  enrolmentId: string;
  fullName: string;
  phone: string;
  score: number;
}

export interface RowError {
  row: number;        // spreadsheet row number as the centre sees it (header = 1)
  field: string;
  value?: string;
  message: string;
}

const HEADER_ALIASES: Record<string, keyof Omit<CandidateRow, 'rowNumber'>> = {
  enrolment_id: 'enrolmentId', enrollment_id: 'enrolmentId', enrolmentid: 'enrolmentId', 'enrolment id': 'enrolmentId',
  full_name: 'fullName', name: 'fullName', 'full name': 'fullName', candidate_name: 'fullName',
  phone: 'phone', mobile: 'phone', whatsapp: 'phone', phone_number: 'phone',
  score: 'score', marks: 'score',
};
const REQUIRED = ['enrolmentId', 'fullName', 'phone', 'score'] as const;

/** Normalise Indian mobile numbers to E.164 (+91XXXXXXXXXX). */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

const rowSchema = z.object({
  enrolmentId: z.string().trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9\-/]{2,29}$/, 'must be 3-30 letters, digits, "-" or "/"'),
  fullName: z.string().trim()
    .min(2, 'is too short')
    .max(100, 'is too long')
    // Blocks spreadsheet formula injection (=, +, -, @) and junk characters.
    .regex(/^[\p{L}][\p{L}\p{M} .'-]*$/u, 'may only contain letters, spaces, . \' and -'),
  phone: z.string().trim().transform((v, ctx) => {
    const p = normalisePhone(v);
    if (!p) { ctx.addIssue({ code: 'custom', message: 'is not a valid 10-digit Indian mobile number' }); return z.NEVER; }
    return p;
  }),
  score: z.string().trim().transform((v, ctx) => {
    const n = Number(v);
    if (v === '' || !Number.isFinite(n) || n < 0 || n > 100) {
      ctx.addIssue({ code: 'custom', message: 'must be a number between 0 and 100' }); return z.NEVER;
    }
    if (n < PASS_MARK) {
      ctx.addIssue({ code: 'custom', message: `is below the pass mark of ${PASS_MARK}; only passed candidates can be certified` });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  }),
});

async function readTable(buffer: Buffer, filename: string): Promise<string[][]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) {
    return parse(buffer, { relax_column_count: true, skip_empty_lines: false, bom: true }) as string[][];
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const out: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value;
        // Formula cells: take the cached result, never the formula itself.
        const val = v && typeof v === 'object' && 'result' in v ? (v as { result: unknown }).result : cell.text ?? v;
        cells[col - 1] = val === null || val === undefined ? '' : String(val);
      });
      out[rowNumber - 1] = cells;
    });
    return Array.from(out, (r) => r ?? []);
  }
  throw new Error('UNSUPPORTED');
}

export async function parseCandidateFile(
  buffer: Buffer, filename: string,
): Promise<{ rows: CandidateRow[]; errors: RowError[] }> {
  let table: string[][];
  try {
    table = await readTable(buffer, filename);
  } catch (e) {
    const msg = (e as Error).message === 'UNSUPPORTED'
      ? 'Only .csv and .xlsx files are accepted'
      : 'The file could not be read. Is it a valid CSV/XLSX file?';
    return { rows: [], errors: [{ row: 0, field: 'file', message: msg }] };
  }

  if (table.length === 0) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: 'The file is empty' }] };
  }

  // Map header columns.
  const header = (table[0] ?? []).map((h) => String(h ?? '').trim().toLowerCase());
  const colIndex: Partial<Record<keyof Omit<CandidateRow, 'rowNumber'>, number>> = {};
  header.forEach((h, i) => { const key = HEADER_ALIASES[h]; if (key && colIndex[key] === undefined) colIndex[key] = i; });
  const missing = REQUIRED.filter((k) => colIndex[k] === undefined);
  if (missing.length) {
    return {
      rows: [],
      errors: [{ row: 1, field: 'header', message: `Missing column(s): ${missing.join(', ')}. Expected headers: enrolment_id, full_name, phone, score` }],
    };
  }

  const rows: CandidateRow[] = [];
  const errors: RowError[] = [];
  const seenEnrolment = new Map<string, number>();

  for (let i = 1; i < table.length; i++) {
    const raw = table[i] ?? [];
    if (raw.every((c) => String(c ?? '').trim() === '')) continue; // blank line
    const rowNumber = i + 1;
    const get = (k: keyof typeof colIndex) => String(raw[colIndex[k]!] ?? '');
    const input = { enrolmentId: get('enrolmentId'), fullName: get('fullName'), phone: get('phone'), score: get('score') };

    const parsed = rowSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? 'row');
        errors.push({ row: rowNumber, field, value: input[field as keyof typeof input], message: `${field} ${issue.message}` });
      }
      continue;
    }
    const key = parsed.data.enrolmentId.toUpperCase();
    const firstRow = seenEnrolment.get(key);
    if (firstRow) {
      errors.push({ row: rowNumber, field: 'enrolmentId', value: parsed.data.enrolmentId, message: `enrolmentId is duplicated (first seen on row ${firstRow})` });
      continue;
    }
    seenEnrolment.set(key, rowNumber);
    rows.push({ rowNumber, ...parsed.data, enrolmentId: key });
  }

  if (rows.length + errors.length === 0) {
    errors.push({ row: 0, field: 'file', message: 'The file has a header but no candidate rows' });
  }
  if (rows.length > MAX_FILE_ROWS) {
    errors.push({ row: 0, field: 'file', message: `Too many rows (max ${MAX_FILE_ROWS})` });
  }
  return { rows, errors };
}
