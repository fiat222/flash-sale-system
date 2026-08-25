import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthTokenDto } from './dto/auth-token.dto';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  token(@Body() dto: AuthTokenDto) {
    return {
      status: 'success',
      accessToken: this.authService.issueToken(dto.userId),
    };
  }
}
