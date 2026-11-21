import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { config } from '../config.js';
import type { Actor } from '../domain/workflow.js';
import type { Role } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';

const ISSUER = 'certiflow';

declare module 'express-serve-static-core' {
  interface Request { actor?: Actor }
}

export function signSession(userId: string): string {
  return jwt.sign({}, config.jwtSecret, { subject: userId, issuer: ISSUER, expiresIn: '8h', algorithm: 'HS256' });
}

/**
 * Identity comes ONLY from the signed token. Role and scope are re-read from
 * the database on every request, so a client can never claim to be someone
 * else by editing a request body, and a deactivated user loses access at once.
 */
export async function actorFromToken(token: string): Promise<Actor> {
  let sub: string | undefined;
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER }) as jwt.JwtPayload;
    sub = p.sub;
  } catch {
    throw unauthorized('Your session is invalid or has expired');
  }
  if (!sub) throw unauthorized();
  const [u] = await db.select().from(users).where(eq(users.id, sub));
  if (!u || u.active !== 1) throw unauthorized('Account not active');
  return { id: u.id, role: u.role, displayName: u.displayName, centreId: u.centreId, districtId: u.districtId };
}

export function authenticate(opts: { allowQueryToken?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('authorization');
    let token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // EventSource cannot set headers, so the SSE endpoint alone accepts ?access_token=
    if (!token && opts.allowQueryToken && typeof req.query.access_token === 'string') token = req.query.access_token;
    if (!token) return next(unauthorized());
    try {
      req.actor = await actorFromToken(token);
      next();
    } catch (e) { next(e); }
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.actor) return next(unauthorized());
    if (!roles.includes(req.actor.role)) return next(forbidden());
    next();
  };
}

export function actorOf(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}
