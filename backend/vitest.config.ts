import { defineConfig } from 'vitest/config';

// Integration tests use a real Postgres + Redis (the docker-compose ones, or
// local ones). They share one database, so files run one after another.
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: './tests/globalSetup.ts',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/certiflow_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      WHATSAPP_URL: 'http://127.0.0.1:4199',
      WHATSAPP_TIMEOUT_MS: '300',
      WHATSAPP_BACKOFF_MS: '50',
      WHATSAPP_MAX_ATTEMPTS: '15',
      CERT_STORAGE_DIR: '/tmp/certiflow-test-certs',
      OUTBOX_POLL_MS: '50',
      SLA_MINUTES: '60',
      VERIFY_RATE_LIMIT_PER_MIN: '1000',
    },
  },
});
