import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthTokenDto } from './dto/auth-token.dto';

@Controller('api/v1/auth')
// Pipe scoped per-controller (not app-global) so it never runs on the read hot
// path — GET /api/v1/products has no DTO and does its own arg parsing.
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Spec 2.1 defines this as "Response (200 OK)"; Nest's default for @Post is
  // 201, which trips other groups' load-test scripts that assert a strict 200.
  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@Body() dto: AuthTokenDto) {
    return {
      status: 'success',
      accessToken: this.authService.issueToken(dto.userId),
    };
  }
}
