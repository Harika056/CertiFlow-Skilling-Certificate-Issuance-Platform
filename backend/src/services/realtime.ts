/**
 * Server-Sent Events hub. Each API instance subscribes to one Redis channel
 * and forwards events to the browsers connected to it, so it works the same
 * with one instance or twenty behind a load balancer.
 *
 * Events carry only ids + type; the browser refetches through the normal,
 * authorised API. Events are filtered so a centre never even learns about
 * another centre's batch ids.
 */
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { Actor } from '../domain/workflow.js';
import { REALTIME_CHANNEL } from '../jobs/queues.js';
import { logger } from '../lib/logger.js';

interface Client { actor: Actor; res: Response }
interface WireEvent { type: string; aggregateId: string; scope: { batchId?: string; centreId?: string; districtId?: string }; at: string }

export function mayHear(actor: Actor, scope: WireEvent['scope']): boolean {
  switch (actor.role) {
    case 'CENTRE': return !!scope.centreId && scope.centreId === actor.centreId;
    case 'DISTRICT_OFFICER': return !!scope.districtId && scope.districtId === actor.districtId;
    default: return true;
  }
}

export function createRealtimeHub(subscriber: Redis) {
  const clients = new Set<Client>();

  subscriber.subscribe(REALTIME_CHANNEL).catch((err) => logger.error({ err }, 'realtime subscribe failed'));
  subscriber.on('message', (_ch, raw) => {
    let ev: WireEvent;
    try { ev = JSON.parse(raw); } catch { return; }
    for (const c of clients) {
      // Certificate events only carry batchId; resolve visibility via batch scope when present.
      if (ev.scope.centreId || ev.scope.districtId ? mayHear(c.actor, ev.scope) : c.actor.role === 'STATE' || c.actor.role === 'QUALITY') {
        c.res.write(`event: change\ndata: ${JSON.stringify({ type: ev.type, id: ev.aggregateId, batchId: ev.scope.batchId, at: ev.at })}\n\n`);
      }
    }
  });

  const heartbeat = setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25_000);
  heartbeat.unref();

  return {
    attach(actor: Actor, res: Response) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: {"ok":true}\n\n`);
      const client = { actor, res };
      clients.add(client);
      res.on('close', () => clients.delete(client));
    },
    size: () => clients.size,
    close() { clearInterval(heartbeat); for (const c of clients) c.res.end(); clients.clear(); },
  };
}
