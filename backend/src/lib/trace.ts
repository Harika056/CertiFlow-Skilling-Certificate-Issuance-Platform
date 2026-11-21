import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * A trace id follows a piece of work from the HTTP request, into the outbox
 * event, onto the queue job and into every audit row it produces.
 */
const store = new AsyncLocalStorage<{ traceId: string }>();

export function currentTraceId(): string {
  return store.getStore()?.traceId ?? 'untraced';
}
export function runWithTrace<T>(traceId: string | undefined, fn: () => T): T {
  return store.run({ traceId: traceId || randomUUID() }, fn);
}
