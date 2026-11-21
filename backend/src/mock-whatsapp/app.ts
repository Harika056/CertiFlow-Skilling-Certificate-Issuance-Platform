/**
 * Stand-in WhatsApp Business provider. Behaves like a real, unreliable one:
 *  - fails some requests with 5xx
 *  - sometimes hangs past the client's timeout (and in half of those cases the
 *    message WAS delivered - the response was simply lost)
 *  - honours an Idempotency-Key header: a retried request with the same key
 *    returns the original message id and is NOT delivered twice
 * It also exposes a "phone inbox" so the demo can show what each candidate got.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';

export interface MockConfig { failRate: number; timeoutRate: number; hangMs: number; outage: boolean }

interface Message { id: string; to: string; text: string; document?: { url: string; filename: string }; receivedAt: string }

export function createMockWhatsApp(initial: Partial<MockConfig> = {}) {
  const cfg: MockConfig = { failRate: 0.2, timeoutRate: 0.1, hangMs: 8000, outage: false, ...initial };
  const byKey = new Map<string, Message>();
  const inbox = new Map<string, Message[]>();
  const stats = { requests: 0, delivered: 0, duplicatesSuppressed: 0, failed: 0, timedOut: 0 };

  const deliver = (key: string, body: Omit<Message, 'id' | 'receivedAt'>) => {
    const msg: Message = { id: `wamid.${randomUUID()}`, receivedAt: new Date().toISOString(), ...body };
    byKey.set(key, msg);
    const list = inbox.get(body.to) ?? [];
    list.push(msg);
    inbox.set(body.to, list);
    stats.delivered++;
    return msg;
  };

  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.post('/v1/messages', async (req, res) => {
    stats.requests++;
    const key = req.header('Idempotency-Key');
    const { to, text, document } = req.body ?? {};
    if (!key || typeof to !== 'string' || typeof text !== 'string') {
      res.status(400).json({ error: 'Idempotency-Key header, to and text are required' });
      return;
    }
    const existing = byKey.get(key);
    if (existing) {
      stats.duplicatesSuppressed++;
      res.status(200).json({ messageId: existing.id, duplicate: true });
      return;
    }
    if (cfg.outage || Math.random() < cfg.failRate) {
      stats.failed++;
      res.status(503).json({ error: 'Service temporarily unavailable' });
      return;
    }
    if (Math.random() < cfg.timeoutRate) {
      stats.timedOut++;
      // Half the time the message goes out but the caller never hears back.
      if (Math.random() < 0.5) deliver(key, { to, text, document });
      await new Promise((r) => setTimeout(r, cfg.hangMs));
      if (!res.headersSent) res.status(504).json({ error: 'gateway timeout' });
      return;
    }
    const msg = deliver(key, { to, text, document });
    res.status(200).json({ messageId: msg.id });
  });

  // Demo helper: which phones have messages (stands in for "the candidate's phone").
  app.get('/v1/inbox', (_req, res) => {
    res.json([...inbox.entries()].map(([phone, msgs]) => ({ phone, count: msgs.length, last: msgs.at(-1)?.receivedAt })));
  });
  app.get('/v1/inbox/:phone', (req, res) => {
    res.json(inbox.get(req.params.phone) ?? []);
  });
  app.get('/v1/stats', (_req, res) => res.json({ ...stats, config: cfg, phones: inbox.size }));
  app.post('/admin/config', (req, res) => {
    const b = req.body ?? {};
    if (typeof b.failRate === 'number') cfg.failRate = b.failRate;
    if (typeof b.timeoutRate === 'number') cfg.timeoutRate = b.timeoutRate;
    if (typeof b.outage === 'boolean') cfg.outage = b.outage;
    res.json(cfg);
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));

  return { app, cfg, inbox, stats };
}
