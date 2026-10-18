import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { RateLimiter } from '../qr/rate-limit';
import { HotelActor, HotelUserGuard } from './hotel-auth.guard';
import { HotelPortalService } from './hotel-portal.service';

class HotelLoginDto {
  @IsString() @MaxLength(200) email: string;
  @IsString() @MaxLength(200) password: string;
}

class AccessCodeDto {
  @IsString() @MinLength(1) @MaxLength(40) accessCode: string;
}

const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// Frena a quien prueba contraseñas: por conexión
const loginLimiter = new RateLimiter(10, 10 * 60 * 1000);

// Portal del hotel. @Public() solo saca estas rutas del login del personal de los restaurantes;
// cada una exige el token de hotel con HotelUserGuard (excepto el login).
@Public()
@Controller('api/hotel-portal')
export class HotelPortalController {
  constructor(private readonly portal: HotelPortalService) {}

  @Post('login')
  login(@Body() dto: HotelLoginDto, @Req() req: any) {
    loginLimiter.hit(ipOf(req), 'Demasiados intentos, esperá unos minutos');
    return this.portal.login(dto.email, dto.password);
  }

  @UseGuards(HotelUserGuard)
  @Get('summary')
  summary(@Req() req: any) {
    return this.portal.summary((req.hotelUser as HotelActor).hotelId);
  }

  @UseGuards(HotelUserGuard)
  @Patch('access-code')
  setAccessCode(@Req() req: any, @Body() dto: AccessCodeDto) {
    return this.portal.setAccessCode((req.hotelUser as HotelActor).hotelId, dto.accessCode);
  }

  @UseGuards(HotelUserGuard)
  @Post('vouchers/:id/cancel')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.portal.cancelVoucher((req.hotelUser as HotelActor).hotelId, id);
  }
}
