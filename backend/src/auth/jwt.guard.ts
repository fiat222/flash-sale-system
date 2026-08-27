import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { FastifyRequest } from 'fastify';

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
      // ตรวจสอบ JWT Signature ตรงๆ แบบ Stateless
      const payload = jwt.verify(token, secret) as jwt.JwtPayload;
      const userId = payload.sub as string;

      (request as FastifyRequest & { userId: string }).userId = userId;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}