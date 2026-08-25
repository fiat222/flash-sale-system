import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { FastifyRequest } from 'fastify';

const VERIFY_CACHE_TTL_MS = 5_000;
const VERIFY_CACHE_MAX_ENTRIES = 10_000;

interface CachedVerification {
  userId: string;
  expiresAt: number;
}

// Verify-cache: some users fire the same token 2-3 times in quick succession.
// Skip re-running HMAC verify for repeat hits within the TTL window.
const verifyCache = new Map<string, CachedVerification>();

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

    const cached = verifyCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      (request as FastifyRequest & { userId: string }).userId = cached.userId;
      return true;
    }

    try {
      const secret = this.config.get<string>('JWT_SECRET', 'changeme');
      const payload = jwt.verify(token, secret) as jwt.JwtPayload;
      const userId = payload.sub as string;

      if (verifyCache.size >= VERIFY_CACHE_MAX_ENTRIES) {
        verifyCache.clear();
      }
      verifyCache.set(token, { userId, expiresAt: Date.now() + VERIFY_CACHE_TTL_MS });

      (request as FastifyRequest & { userId: string }).userId = userId;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
