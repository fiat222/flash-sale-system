import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class AuthService {
  constructor(private readonly config: ConfigService) {}

  issueToken(userId: string): string {
    const secret = this.config.get<string>('JWT_SECRET', 'changeme');
    const expiresIn = this.config.get<string>('JWT_EXPIRES_IN', '1h');
    return jwt.sign({ sub: userId }, secret, { expiresIn } as jwt.SignOptions);
  }
}
