import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: process.env.SERVICE_NAME ?? 'certiflow' },
  // Never log personal data in plain text.
  redact: ['req.headers.authorization', '*.phone', '*.token'],
});
