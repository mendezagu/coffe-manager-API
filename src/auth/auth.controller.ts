import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RateLimiter } from '../qr/rate-limit';
import { AllowPendingPassword } from './allow-password-change.decorator';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';

class LoginDto {
  // Usuario del local (puede ser un email). Se sigue llamando email por compatibilidad con versiones anteriores de la app
  @IsString() @MaxLength(80)
  email: string;

  @IsString() @MaxLength(100)
  password: string;

  // Código del local
  @IsOptional() @IsString() @MaxLength(40)
  code?: string;
}

// Frena a quien prueba claves: por conexión y por usuario dentro de cada local
const ipLimiter = new RateLimiter(30, 10 * 60 * 1000);
const userLimiter = new RateLimiter(10, 10 * 60 * 1000);
const localLimiter = new RateLimiter(40, 10 * 60 * 1000);
const ipOf = (req: any): string => String(req?.ip ?? req?.socket?.remoteAddress ?? 'desconocida');

class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  @MaxLength(100)
  newPassword: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    ipLimiter.hit(ipOf(req), 'Demasiados intentos. Esperá unos minutos.');
    userLimiter.hit(`${(dto.code ?? '').trim().toLowerCase()}:${dto.email.trim().toLowerCase()}`, 'Demasiados intentos con este usuario. Esperá unos minutos.');
    return this.auth.login(dto.email, dto.password, dto.code);
  }

  // Nombre y logo del local, para confirmar el código antes de pedir la clave
  @Public()
  @Get('local/:code')
  local(@Param('code') code: string, @Req() req: any) {
    localLimiter.hit(ipOf(req), 'Demasiadas consultas. Esperá unos minutos.');
    return this.auth.localInfo(code);
  }

  // Token nuevo para quien ya tiene sesión (renovación mientras trabaja)
  @AllowPendingPassword()
  @Post('refresh')
  refresh(@Req() req: any) {
    return this.auth.refresh(req.user.id);
  }

  @AllowPendingPassword()
  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }

  @AllowPendingPassword()
  @Post('change-password')
  changePassword(@Req() req: any, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(req.user.id, dto.currentPassword, dto.newPassword);
  }
}
