import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import multer from 'multer';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { config } from './config.js';
import { db, pool } from './db/client.js';
import { auditLog, users } from './db/schema.js';
import { actorOf, authenticate, requireRole, signSession } from './auth/auth.js';
import { AppError, badRequest, notFound } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { rateLimit } from './lib/rateLimit.js';
import { redis } from './lib/redis.js';
import { runWithTrace } from './lib/trace.js';
import * as batchSvc from './services/batchService.js';
import * as certSvc from './services/certificateService.js';
import { retryDelivery } from './services/deliveryService.js';
import { stuckOverview } from './services/slaService.js';
import { createRealtimeHub } from './services/realtime.js';

const uuidParam = z.string().uuid();
function id(req: Request, name = 'id'): string {
  const parsed = uuidParam.safeParse(req.params[name]);
  if (!parsed.success) throw notFound();
  return parsed.data;
}
function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw badRequest('Invalid request', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  return r.data;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

export function createApp(opts: { subscriber?: Redis } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.publicBaseUrl, credentials: false }));
  app.use(express.json({ limit: '50kb' }));

  // Every request gets a trace id (or keeps the caller's), returned in a header
  // and stored on every audit row / event it causes.
  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    const traceId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', traceId);
    runWithTrace(traceId, () => next());
  });
  app.use(pinoHttp({ logger, genReqId: (_req, res) => String(res.getHeader('x-request-id')), autoLogging: { ignore: (req) => req.url === '/health' } }));

  const hub = opts.subscriber ? createRealtimeHub(opts.subscriber) : null;

  // ------------------------------------------------------------------ health
  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/ready', async (_req, res) => {
    try { await pool.query('SELECT 1'); await redis.ping(); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // ------------------------------------------------------------------ auth (demo)
  app.get('/api/auth/demo-users', async (_req, res) => {
    if (!config.demoLoginEnabled) throw notFound();
    const rows = await db.select({ username: users.username, displayName: users.displayName, role: users.role }).from(users).orderBy(asc(users.role));
    res.json(rows);
  });
  app.post('/api/auth/demo-login', async (req, res) => {
    if (!config.demoLoginEnabled) throw notFound();
    const { username } = body(z.object({ username: z.string().min(1).max(50) }), req);
    const [u] = await db.select().from(users).where(eq(users.username, username.toLowerCase()));
    if (!u || u.active !== 1) throw new AppError(401, 'UNAUTHORIZED', 'Unknown user');
    res.json({ token: signSession(u.id), user: { id: u.id, displayName: u.displayName, role: u.role } });
  });

  // ------------------------------------------------------------------ public (no login)
  app.get('/api/public/verify/:code', rateLimit('verify', config.verifyRateLimitPerMin), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await certSvc.verifyCertificate(String(req.params.code ?? '')));
  });
  app.get('/api/public/certificates/download/:token', rateLimit('download', 30), async (req, res) => {
    const f = await certSvc.resolveDownload(String(req.params.token));
    res.download(path.resolve(f.file), f.filename);
  });

  // ------------------------------------------------------------------ authenticated
  app.get('/api/events', authenticate({ allowQueryToken: true }), (req, res) => {
    if (!hub) { res.status(503).end(); return; }
    hub.attach(actorOf(req), res);
  });

  const api = express.Router();
  api.use(authenticate());

  api.get('/me', (req, res) => { res.json(actorOf(req)); });

  api.get('/batches', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(await batchSvc.listBatches(actorOf(req), { inbox: req.query.inbox === '1', status: status as never }));
  });
  api.post('/batches', requireRole('CENTRE'), async (req, res) => {
    const input = body(z.object({ title: z.string().trim().min(3).max(120), course: z.string().trim().min(2).max(120) }).strict(), req);
    res.status(201).json(await batchSvc.createBatch(actorOf(req), input));
  });
  api.get('/batches/:id', async (req, res) => { res.json(await batchSvc.getBatch(actorOf(req), id(req))); });
  api.post('/batches/:id/candidates', requireRole('CENTRE'), upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Attach the spreadsheet as "file"');
    res.json(await batchSvc.uploadCandidates(actorOf(req), id(req), req.file));
  });
  api.post('/batches/:id/submit', requireRole('CENTRE'), async (req, res) => {
    res.json(await batchSvc.submitBatch(actorOf(req), id(req)));
  });
  api.post('/batches/:id/votes', requireRole('DISTRICT_OFFICER', 'QUALITY', 'STATE'), async (req, res) => {
    const input = body(z.object({
      decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
      reason: z.string().max(1000).optional(),
      expectedRound: z.number().int().positive().optional(),
    }).strict(), req);
    res.json(await batchSvc.castVote(actorOf(req), id(req), input));
  });
  api.post('/batches/:id/votes/withdraw', requireRole('DISTRICT_OFFICER', 'QUALITY', 'STATE'), async (req, res) => {
    const { reason } = body(z.object({ reason: z.string().trim().min(3).max(1000) }).strict(), req);
    res.json(await batchSvc.withdrawVote(actorOf(req), id(req), reason));
  });
  // End-to-end trace: every decision and system step for one batch, in order.
  api.get('/batches/:id/trace', async (req, res) => {
    const batchId = id(req);
    await batchSvc.getBatch(actorOf(req), batchId); // authorisation check
    const rows = await db.select().from(auditLog).where(eq(auditLog.batchId, batchId)).orderBy(asc(auditLog.id));
    res.json(rows);
  });

  api.get('/state/stuck', requireRole('STATE'), async (req, res) => { res.json(await stuckOverview(actorOf(req))); });
  api.get('/certificates/by-number/:certNumber', requireRole('STATE'), async (req, res) => {
    res.json(await certSvc.findCertificate(actorOf(req), String(req.params.certNumber)));
  });
  api.post('/certificates/by-number/:certNumber/revoke', requireRole('STATE'), async (req, res) => {
    const { reason } = body(z.object({ reason: z.string().trim().min(3).max(1000) }).strict(), req);
    res.json(await certSvc.revokeCertificate(actorOf(req), String(req.params.certNumber).toUpperCase(), reason));
  });
  api.post('/certificates/:id/retry-delivery', requireRole('STATE'), async (req, res) => {
    res.json(await retryDelivery(actorOf(req), id(req)));
  });
  api.get('/certificates/:id/pdf', requireRole('CENTRE', 'STATE'), async (req, res) => {
    const f = await certSvc.staffDownload(actorOf(req), id(req));
    res.download(path.resolve(f.file), f.filename);
  });

  app.use('/api', api);

  // ------------------------------------------------------------------ errors
  app.use((_req, _res, next) => next(notFound('No such endpoint')));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; code?: string; status?: number; message?: string };
    if (e?.type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } }); return; }
    if (e?.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'File is larger than 2 MB' } }); return; }
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Quote this id to support.', traceId: res.getHeader('x-request-id') } });
  });

  return { app, hub };
}
