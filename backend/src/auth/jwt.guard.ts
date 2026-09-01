import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { FastifyRequest } from 'fastify';

// Verify-cache (lab 6): the load test reuses each of ~500 tokens across the
// whole run, so the raw HMAC-SHA256 verify is the same work thousands of times.
// Cache the verified result (token -> userId) for a short window, capped to the
// token's own `exp` so an expired token can't ride the cache. This caches an
// auth check, not response data — it does not touch the product-cache rule.
const VERIFY_TTL_MS = 30_000;
const VERIFY_MAX = 2000; // hard cap; cleared wholesale on overflow (cheap, rare)
const verifyCache = new Map<string, { userId: string; expiresAt: number }>();

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    const now = Date.now();

    const cached = verifyCache.get(token);
    if (cached && cached.expiresAt > now) {
      (request as FastifyRequest & { userId: string }).userId = cached.userId;
      return true;
    }

    try {
      const secret = this.config.get<string>('JWT_SECRET', 'changeme');
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      const userId = payload.sub as string;

      const tokenExpMs = payload.exp ? payload.exp * 1000 : Number.POSITIVE_INFINITY;
      const expiresAt = Math.min(now + VERIFY_TTL_MS, tokenExpMs);
      if (expiresAt > now) {
        if (verifyCache.size >= VERIFY_MAX) verifyCache.clear();
        verifyCache.set(token, { userId, expiresAt });
      }

      (request as FastifyRequest & { userId: string }).userId = userId;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
