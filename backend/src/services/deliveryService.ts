import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { certificates, deliveries } from '../db/schema.js';
import { config } from '../config.js';
import type { Actor } from '../domain/workflow.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { audit, emit } from './events.js';
import { signDownloadToken, verifyUrl } from './certificateService.js';

export class RetryableDeliveryError extends Error {}

/** Thin client for the WhatsApp provider. Every call has a hard timeout. */
export async function sendWhatsApp(msg: {
  to: string; text: string; document?: { url: string; filename: string }; idempotencyKey: string;
}): Promise<{ messageId: string; duplicate?: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.whatsappTimeoutMs);
  try {
    const res = await fetch(`${config.whatsappUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': msg.idempotencyKey },
      body: JSON.stringify({ to: msg.to, text: msg.text, document: msg.document }),
      signal: ctrl.signal,
    });
    if (res.status >= 500 || res.status === 429) throw new RetryableDeliveryError(`provider returned ${res.status}`);
    if (!res.ok) throw new Error(`provider rejected message: ${res.status} ${await res.text()}`);
    return (await res.json()) as { messageId: string; duplicate?: boolean };
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new RetryableDeliveryError(`provider timed out after ${config.whatsappTimeoutMs}ms`);
    if (err instanceof TypeError) throw new RetryableDeliveryError(`provider unreachable: ${(err as Error).message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver one certificate. Called by the queue with retries + backoff.
 * Exactly-once on the phone comes from: one delivery row per certificate
 * (unique), a stable idempotency key (the delivery id) reused on every retry,
 * and skipping as soon as the row says SENT.
 */
export async function deliverCertificate(certificateId: string) {
  const [row] = await db.select({ d: deliveries, c: certificates })
    .from(deliveries).innerJoin(certificates, eq(certificates.id, deliveries.certificateId))
    .where(eq(deliveries.certificateId, certificateId));
  if (!row) throw new Error(`no delivery for certificate ${certificateId}`);
  const { d, c } = row;
  if (d.status === 'SENT') return { skipped: 'already sent' };
  if (c.status === 'REVOKED') {
    await db.update(deliveries).set({ status: 'FAILED', lastError: 'certificate revoked before delivery', updatedAt: new Date() })
      .where(eq(deliveries.id, d.id));
    return { skipped: 'revoked' };
  }
  if (c.pdfStatus !== 'READY') throw new RetryableDeliveryError('pdf not ready yet');

  await db.update(deliveries).set({ status: 'SENDING', attempts: sql`${deliveries.attempts} + 1`, updatedAt: new Date() })
    .where(eq(deliveries.id, d.id));

  const link = `${config.apiBaseUrl}/api/public/certificates/download/${signDownloadToken(c.id)}`;
  try {
    const res = await sendWhatsApp({
      to: d.phone,
      idempotencyKey: d.id,
      text: `Congratulations ${c.holderName}! Your Pragati Skills Mission certificate for "${c.course}" (No. ${c.certNumber}) is ready. ` +
        `Download: ${link} . Anyone can check it is genuine at ${verifyUrl(c.verificationCode)}`,
      document: { url: link, filename: `${c.certNumber}.pdf` },
    });
    await db.transaction(async (tx) => {
      await tx.update(deliveries).set({ status: 'SENT', providerMessageId: res.messageId, lastError: null, updatedAt: new Date() })
        .where(eq(deliveries.id, d.id));
      await audit(tx, null, 'WHATSAPP_DELIVERED', { type: 'certificate', id: c.id, batchId: c.batchId },
        { attempt: d.attempts + 1, providerMessageId: res.messageId, providerSaidDuplicate: !!res.duplicate });
      await emit(tx, { type: 'CertificateDelivered', aggregateId: c.id, scope: { batchId: c.batchId } });
    });
    return { sent: true };
  } catch (err) {
    await db.update(deliveries).set({ status: 'PENDING', lastError: (err as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(deliveries.id, d.id));
    throw err;
  }
}

/** Called once the queue has used up all retries. */
export async function markDeliveryFailed(certificateId: string, reason: string) {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(certificates).where(eq(certificates.id, certificateId));
    const updated = await tx.update(deliveries).set({ status: 'FAILED', lastError: reason.slice(0, 500), updatedAt: new Date() })
      .where(sql`${deliveries.certificateId} = ${certificateId} AND ${deliveries.status} <> 'SENT'`).returning();
    if (!c || updated.length === 0) return;
    await audit(tx, null, 'WHATSAPP_GAVE_UP', { type: 'certificate', id: c.id, batchId: c.batchId }, { reason });
    await emit(tx, { type: 'CertificateDeliveryFailed', aggregateId: c.id, scope: { batchId: c.batchId } });
  });
}

/** State office can push a failed delivery round again (e.g. after an outage). */
export async function retryDelivery(actor: Actor, certificateId: string) {
  if (actor.role !== 'STATE') throw forbidden('Only the state office can retry deliveries');
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ d: deliveries, c: certificates }).from(deliveries)
      .innerJoin(certificates, eq(certificates.id, deliveries.certificateId))
      .where(eq(deliveries.certificateId, certificateId)).for('update');
    if (!row) throw notFound('Certificate not found');
    if (row.d.status !== 'FAILED') throw conflict(`Delivery is ${row.d.status}; only FAILED deliveries can be retried`);
    if (row.c.status === 'REVOKED') throw conflict('Certificate is revoked');
    await tx.update(deliveries).set({ status: 'PENDING', updatedAt: new Date() }).where(eq(deliveries.id, row.d.id));
    await audit(tx, actor, 'WHATSAPP_RETRY_REQUESTED', { type: 'certificate', id: row.c.id, batchId: row.c.batchId });
    // Re-emitting PdfReady routes it to the WhatsApp queue again. Same idempotency key.
    await emit(tx, { type: 'CertificatePdfReady', aggregateId: row.c.id, scope: { batchId: row.c.batchId } });
    return { status: 'PENDING' };
  });
}
