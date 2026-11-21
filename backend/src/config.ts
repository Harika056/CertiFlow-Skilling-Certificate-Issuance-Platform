// Central configuration. Everything comes from environment variables so the
// same image runs locally, in tests and in production.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env ${name}`);
  return v;
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 4000),
  databaseUrl: str('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/certiflow'),
  redisUrl: str('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: str('JWT_SECRET', 'dev-only-secret-change-me-in-production-please'),
  // Separate key for candidate download links, so leaking one never forges the other.
  downloadLinkSecret: str('DOWNLOAD_LINK_SECRET', 'dev-only-download-secret-change-me'),
  demoLoginEnabled: str('DEMO_LOGIN_ENABLED', 'true') === 'true',
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:5173'),
  apiBaseUrl: str('API_PUBLIC_URL', 'http://localhost:4000'),
  whatsappUrl: str('WHATSAPP_URL', 'http://localhost:4100'),
  whatsappTimeoutMs: num('WHATSAPP_TIMEOUT_MS', 3000),
  certStorageDir: str('CERT_STORAGE_DIR', './data/certs'),

  // Business rules (documented in README "Requirements note").
  districtQuorum: num('DISTRICT_QUORUM', 2),
  largeBatchThreshold: num('LARGE_BATCH_THRESHOLD', 50),
  maxBatchSize: num('MAX_BATCH_SIZE', 500),
  slaMinutes: num('SLA_MINUTES', 48 * 60),
  slaScanIntervalMs: num('SLA_SCAN_INTERVAL_MS', 30_000),
  outboxPollMs: num('OUTBOX_POLL_MS', 250),
  verifyCacheTtlSec: num('VERIFY_CACHE_TTL_SEC', 30),
  verifyRateLimitPerMin: num('VERIFY_RATE_LIMIT_PER_MIN', 60),
  whatsappMaxAttempts: num('WHATSAPP_MAX_ATTEMPTS', 8),
  whatsappBackoffMs: num('WHATSAPP_BACKOFF_MS', 2000),
  // Global cap across ALL worker instances (BullMQ limiter lives in Redis), to stay under the provider's throughput tier.
  whatsappRatePerSec: num('WHATSAPP_RATE_PER_SEC', 50),
};
