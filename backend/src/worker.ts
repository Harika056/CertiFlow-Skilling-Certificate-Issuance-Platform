import { createRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './jobs/processors.js';
import { pool } from './db/client.js';

const connection = createRedis();
const publisher = createRedis();

const running = await startWorkers(connection, publisher);
logger.info('worker started: relay + issuance + pdf + whatsapp + sla');

// Graceful shutdown: finish in-flight jobs. If we are killed instead, BullMQ
// marks the jobs stalled and another worker picks them up.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, 'shutting down worker');
    await running.close();
    await pool.end();
    connection.disconnect();
    publisher.disconnect();
    process.exit(0);
  });
}
