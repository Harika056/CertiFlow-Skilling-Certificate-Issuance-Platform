import { Redis } from 'ioredis';
import { config } from '../config.js';

/** Factory: BullMQ needs maxRetriesPerRequest=null; pub/sub needs its own connection. */
export function createRedis(): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

/** Shared connection for caching / rate limiting / publishing. */
export const redis = createRedis();
