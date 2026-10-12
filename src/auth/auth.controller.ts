import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { IsString } from 'class-validator';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

class LoginDto {
  @IsString()
  email: string;

  @IsString()
  password: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }
}
