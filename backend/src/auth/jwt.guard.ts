import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { FastifyRequest } from 'fastify';

// Stateless JWT (lab 6): every instance verifies the token on its own with the
// shared secret — no server-side session, nothing cached in process.
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

    try {
      const secret = this.config.get<string>('JWT_SECRET', 'changeme');
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      (request as FastifyRequest & { userId: string }).userId = payload.sub as string;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
