import { createApp } from './app.js';
import { config } from './config.js';
import { createRedis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import { pool } from './db/client.js';

const subscriber = createRedis();
const { app, hub } = createApp({ subscriber });

const server = app.listen(config.port, () => logger.info({ port: config.port }, 'api listening'));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    logger.info({ sig }, 'shutting down api');
    hub?.close();
    server.close(async () => { await pool.end(); subscriber.disconnect(); process.exit(0); });
  });
}
