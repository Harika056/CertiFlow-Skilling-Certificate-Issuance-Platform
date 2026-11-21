import { and, asc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { db } from '../db/client.js';
import { auditLog, batches, candidates, centres, certificates, deliveries } from '../db/schema.js';
import { config } from '../config.js';
import type { Actor } from '../domain/workflow.js';
import { conflict, forbidden, notFound, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { audit, emit } from './events.js';
import { enrolmentKey, scopeOf } from './batchService.js';

// Unambiguous alphabet (no 0/O, 1/I/L). 12 chars ≈ 60 bits: not guessable.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newVerificationCode(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}
export const VERIFY_CODE_RE = /^[A-HJ-NP-Z2-9]{12}$/;

// ------------------------------------------------------------------ issuance

/**
 * Creates exactly one certificate per candidate of an APPROVED batch.
 * Idempotent: safe to run again after a crash or a duplicate event.
 */
export async function issueBatch(batchId: string) {
  return db.transaction(async (tx) => {
    const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for('update');
    if (!batch) throw new Error(`batch ${batchId} vanished`);
    if (batch.status === 'ISSUED') return { created: 0, alreadyIssued: true };
    if (batch.status !== 'APPROVED') {
      logger.warn({ batchId, status: batch.status }, 'issueBatch called for non-approved batch; ignoring');
      return { created: 0, alreadyIssued: false };
    }
    const [centre] = await tx.select().from(centres).where(eq(centres.id, batch.centreId));
    const cands = await tx.select().from(candidates).where(eq(candidates.batchId, batchId)).orderBy(asc(candidates.rowNumber));

    let created = 0;
    const skipped: string[] = [];
    for (const c of cands) {
      const [cert] = await tx.insert(certificates).values({
        // Number comes from a DB sequence: unique across any number of workers.
        certNumber: sql`'PSM-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('certificate_number_seq')::text, 7, '0')`,
        verificationCode: newVerificationCode(),
        candidateId: c.id,
        enrolmentKey: enrolmentKey(centre!.code, c.enrolmentId, batch.course),
        batchId, holderName: c.fullName, course: batch.course, centreName: centre!.name,
      }).onConflictDoNothing().returning();

      if (!cert) {
        // Either this candidate already has one (re-run) or the same person was
        // certified for this course via another batch. Never issue a second.
        const [existing] = await tx.select({ id: certificates.id }).from(certificates).where(eq(certificates.candidateId, c.id));
        if (!existing) skipped.push(c.enrolmentId);
        continue;
      }
      created++;
      await tx.insert(deliveries).values({ certificateId: cert.id, phone: c.phone }).onConflictDoNothing();
      await emit(tx, { type: 'CertificateIssued', aggregateId: cert.id, scope: scopeOf(batch), data: { certNumber: cert.certNumber } });
    }

    await tx.update(batches).set({ status: 'ISSUED', updatedAt: new Date() }).where(eq(batches.id, batchId));
    await audit(tx, null, 'CERTIFICATES_ISSUED', { type: 'batch', id: batchId, batchId }, { created, skippedAsDuplicate: skipped });
    await emit(tx, { type: 'BatchIssued', aggregateId: batchId, scope: scopeOf(batch), data: { created } });
    return { created, alreadyIssued: false };
  });
}

// ------------------------------------------------------------------ PDF

export function pdfPathFor(certNumber: string) {
  return path.join(config.certStorageDir, `${certNumber}.pdf`);
}

export function verifyUrl(code: string) {
  return `${config.publicBaseUrl}/verify/${code}`;
}

async function renderPdf(cert: typeof certificates.$inferSelect): Promise<Buffer> {
  const qr = await QRCode.toBuffer(verifyUrl(cert.verificationCode), { margin: 1, width: 160 });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50, info: { Title: `Certificate ${cert.certNumber}` } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const w = doc.page.width;
  doc.rect(25, 25, w - 50, doc.page.height - 50).lineWidth(3).stroke('#1f4e79');
  doc.fillColor('#1f4e79').fontSize(14).text('PRAGATI SKILLS MISSION', 0, 70, { align: 'center' });
  doc.fontSize(30).text('Certificate of Skill Completion', 0, 100, { align: 'center' });
  doc.fillColor('#333').fontSize(14).text('This is to certify that', 0, 170, { align: 'center' });
  doc.fillColor('#000').fontSize(28).text(cert.holderName, 0, 195, { align: 'center' });
  doc.fillColor('#333').fontSize(14)
    .text(`has successfully completed the course`, 0, 245, { align: 'center' })
    .fontSize(20).fillColor('#000').text(cert.course, 0, 268, { align: 'center' })
    .fontSize(13).fillColor('#333').text(`at ${cert.centreName}`, 0, 300, { align: 'center' });
  doc.fontSize(11).fillColor('#000')
    .text(`Certificate No: ${cert.certNumber}`, 60, 420)
    .text(`Issued on: ${cert.issuedAt.toISOString().slice(0, 10)}`, 60, 438)
    .text(`Verification code: ${cert.verificationCode}`, 60, 456)
    .fillColor('#555').text(`Verify at ${verifyUrl(cert.verificationCode)}`, 60, 474);
  doc.image(qr, w - 220, 380, { width: 130 });
  doc.end();
  return done;
}

/** Idempotent: if the PDF is already READY nothing is redone. */
export async function generatePdf(certificateId: string) {
  const [cert] = await db.select().from(certificates).where(eq(certificates.id, certificateId));
  if (!cert) throw new Error(`certificate ${certificateId} not found`);
  const file = pdfPathFor(cert.certNumber);
  if (cert.pdfStatus === 'READY') return { skipped: true };

  const buf = await renderPdf(cert);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write to a temp name then rename: a crash never leaves a half-written PDF.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);

  await db.transaction(async (tx) => {
    const updated = await tx.update(certificates).set({ pdfStatus: 'READY', pdfPath: file })
      .where(and(eq(certificates.id, certificateId), eq(certificates.pdfStatus, 'PENDING'))).returning({ id: certificates.id });
    if (updated.length === 0) return; // another worker won the race; its event is already out
    await audit(tx, null, 'PDF_GENERATED', { type: 'certificate', id: cert.id, batchId: cert.batchId }, { bytes: buf.length });
    await emit(tx, { type: 'CertificatePdfReady', aggregateId: cert.id, scope: { batchId: cert.batchId } });
  });
  return { skipped: false };
}

// ------------------------------------------------------------------ download links

export function signDownloadToken(certificateId: string): string {
  return jwt.sign({ cid: certificateId, p: 'dl' }, config.downloadLinkSecret, { expiresIn: '30d', algorithm: 'HS256' });
}

export async function resolveDownload(token: string) {
  let payload: { cid?: string; p?: string };
  try {
    payload = jwt.verify(token, config.downloadLinkSecret, { algorithms: ['HS256'] }) as typeof payload;
  } catch {
    throw forbidden('This download link is invalid or has expired');
  }
  if (payload.p !== 'dl' || !payload.cid) throw forbidden('This download link is invalid');
  return loadPdfForDownload(payload.cid);
}

export async function loadPdfForDownload(certificateId: string) {
  const [cert] = await db.select().from(certificates).where(eq(certificates.id, certificateId));
  if (!cert) throw notFound('Certificate not found');
  if (cert.status === 'REVOKED') throw conflict('This certificate has been cancelled and can no longer be downloaded');
  if (cert.pdfStatus !== 'READY' || !cert.pdfPath) throw conflict('The certificate PDF is still being prepared, try again shortly');
  return { file: cert.pdfPath, filename: `${cert.certNumber}.pdf` };
}

/** Staff download: owning centre or state office only. */
export async function staffDownload(actor: Actor, certificateId: string) {
  const [row] = await db.select({ centreId: batches.centreId }).from(certificates)
    .innerJoin(batches, eq(batches.id, certificates.batchId)).where(eq(certificates.id, certificateId));
  if (!row) throw notFound('Certificate not found');
  const allowed = actor.role === 'STATE' || (actor.role === 'CENTRE' && actor.centreId === row.centreId);
  if (!allowed) throw notFound('Certificate not found');
  return loadPdfForDownload(certificateId);
}

// ------------------------------------------------------------------ revoke + verify

const cacheKey = (code: string) => `verify:${code}`;

export async function revokeCertificate(actor: Actor, certNumber: string, reason: string) {
  if (actor.role !== 'STATE') throw forbidden('Only the state office can cancel a certificate');
  if (!reason?.trim()) throw badRequest('A reason is required to cancel a certificate');

  const result = await db.transaction(async (tx) => {
    const [cert] = await tx.select().from(certificates).where(eq(certificates.certNumber, certNumber)).for('update');
    if (!cert) throw notFound('No certificate with that number');
    if (cert.status === 'REVOKED') throw conflict('This certificate is already cancelled');
    await tx.update(certificates).set({ status: 'REVOKED', revokedAt: new Date(), revokedBy: actor.id, revokeReason: reason.trim() })
      .where(eq(certificates.id, cert.id));
    await audit(tx, actor, 'CERTIFICATE_REVOKED', { type: 'certificate', id: cert.id, batchId: cert.batchId }, { certNumber, reason: reason.trim() });
    await emit(tx, { type: 'CertificateRevoked', aggregateId: cert.id, scope: { batchId: cert.batchId }, data: { certNumber } });
    return cert;
  });

  // Invalidate the public cache right after commit. If Redis is down the
  // entry still expires within VERIFY_CACHE_TTL_SEC (30s), well inside a minute.
  try { await redis.del(cacheKey(result.verificationCode)); }
  catch (err) { logger.error({ err, certNumber }, 'verify cache invalidation failed; relying on TTL'); }
  return { certNumber, status: 'REVOKED' as const };
}

export interface VerifyResult {
  result: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  certificate?: {
    certNumber: string; holderName: string; course: string; centreName: string;
    issuedAt: string; revokedAt: string | null;
  };
  checkedAt: string;
}

/** Public lookup. Shows only what an employer needs; never phone or scores. */
export async function verifyCertificate(code: string): Promise<VerifyResult> {
  const normal = code.trim().toUpperCase();
  if (!VERIFY_CODE_RE.test(normal)) return { result: 'NOT_FOUND', checkedAt: new Date().toISOString() };

  try {
    const hit = await redis.get(cacheKey(normal));
    if (hit) return { ...(JSON.parse(hit) as VerifyResult), checkedAt: new Date().toISOString() };
  } catch (err) { logger.warn({ err }, 'verify cache read failed; using database'); }

  const [cert] = await db.select().from(certificates).where(eq(certificates.verificationCode, normal));
  const res: VerifyResult = cert
    ? {
      result: cert.status === 'REVOKED' ? 'REVOKED' : 'VALID',
      certificate: {
        certNumber: cert.certNumber, holderName: cert.holderName, course: cert.course, centreName: cert.centreName,
        issuedAt: cert.issuedAt.toISOString(), revokedAt: cert.revokedAt?.toISOString() ?? null,
      },
      checkedAt: new Date().toISOString(),
    }
    : { result: 'NOT_FOUND', checkedAt: new Date().toISOString() };

  try { await redis.set(cacheKey(normal), JSON.stringify(res), 'EX', config.verifyCacheTtlSec); }
  catch (err) { logger.warn({ err }, 'verify cache write failed'); }
  return res;
}

export async function findCertificate(actor: Actor, certNumber: string) {
  if (actor.role !== 'STATE') throw forbidden();
  const [row] = await db.select({
    id: certificates.id, certNumber: certificates.certNumber, holderName: certificates.holderName, course: certificates.course,
    centreName: certificates.centreName, status: certificates.status, issuedAt: certificates.issuedAt,
    revokedAt: certificates.revokedAt, revokeReason: certificates.revokeReason, batchId: certificates.batchId,
    pdfStatus: certificates.pdfStatus, delivery: deliveries.status, deliveryAttempts: deliveries.attempts, lastError: deliveries.lastError,
  }).from(certificates).leftJoin(deliveries, eq(deliveries.certificateId, certificates.id))
    .where(eq(certificates.certNumber, certNumber.trim().toUpperCase()));
  if (!row) throw notFound('No certificate with that number');
  const trail = await db.select().from(auditLog)
    .where(and(eq(auditLog.entityType, 'certificate'), eq(auditLog.entityId, row.id))).orderBy(asc(auditLog.id));
  return { ...row, trail };
}
