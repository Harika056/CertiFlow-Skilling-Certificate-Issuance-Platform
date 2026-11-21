import type { NextFunction, Request, Response } from 'express';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { AppError } from './errors.js';

/**
 * Fixed-window limiter in Redis, shared by every API instance.
 * Fails open: if Redis is down we keep verifying rather than lock employers out.
 */
export function rateLimit(name: string, perMinute: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:${name}:${req.ip}:${window}`;
    try {
      const n = await redis.incr(key);
      if (n === 1) await redis.expire(key, 70);
      res.setHeader('X-RateLimit-Limit', perMinute);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, perMinute - n));
      if (n > perMinute) return next(new AppError(429, 'RATE_LIMITED', 'Too many checks from your network. Try again in a minute.'));
    } catch (err) {
      logger.warn({ err }, 'rate limiter unavailable; allowing request');
    }
    next();
  };
}
