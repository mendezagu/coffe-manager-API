import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ReservationStatus, Role, WaitlistStatus } from '@prisma/client';
import { IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { RateLimiter } from '../qr/rate-limit';
import { ReservationsService } from './reservations.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{1,2}:\d{2}$/;
const SLUG = /^[a-z0-9-]{1,60}$/;

class BookDto {
  @IsString() @Matches(DAY) date: string;
  @IsString() @Matches(TIME) time: string;
  @IsInt() @Min(1) @Max(1000) partySize: number;
  @IsString() @MinLength(2) @MaxLength(60) guestName: string;
  @IsString() @MinLength(6) @MaxLength(25) guestPhone: string;
  @IsOptional() @IsEmail() @MaxLength(120) guestEmail?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

class ManualBookDto extends BookDto {
  // "reservar igual": el personal puede pasarse de la capacidad
  @IsOptional() @IsBoolean() force?: boolean;
}

class CancelDto {
  @IsString() @MinLength(4) @MaxLength(12) code: string;
  @IsString() @MinLength(6) @MaxLength(25) phone: string;
}

class WaitlistDto {
  @IsString() @Matches(DAY) date: string;
  @IsString() @Matches(TIME) fromTime: string;
  @IsString() @Matches(TIME) toTime: string;
  @IsInt() @Min(1) @Max(1000) partySize: number;
  @IsString() @MinLength(2) @MaxLength(60) guestName: string;
  @IsString() @MinLength(6) @MaxLength(25) guestPhone: string;
}

class UpdateReservationDto {
  @IsOptional() @IsIn(['PENDING', 'CONFIRMED', 'ARRIVED', 'NO_SHOW', 'CANCELLED']) status?: ReservationStatus;
  @IsOptional() @IsString() @MaxLength(64) tableId?: string | null;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @IsOptional() @IsString() @Matches(DAY) date?: string;
  @IsOptional() @IsString() @Matches(TIME) time?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) partySize?: number;
  @IsOptional() @IsBoolean() force?: boolean;
}

class WaitlistStatusDto {
  @IsIn(['WAITING', 'CONTACTED', 'BOOKED', 'CANCELLED']) status: WaitlistStatus;
}

class WaitlistBookDto {
  @IsString() @Matches(TIME) time: string;
}

const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// Frenos por conexión y por restaurante: reservar, consultar horarios, anotarse en espera y cancelar
const bookLimiter = new RateLimiter(10, 10 * 60 * 1000);
const availabilityLimiter = new RateLimiter(80, 10 * 60 * 1000);
const waitlistLimiter = new RateLimiter(6, 10 * 60 * 1000);
const cancelLimiter = new RateLimiter(10, 10 * 60 * 1000);

// ---------------------------------------------------------------------------------------------
// Página pública del restaurante (sin sesión): ver horarios, reservar, anotarse en espera, cancelar
// ---------------------------------------------------------------------------------------------
@Public()
@Controller('api/public/reservas')
export class ReservationsPublicController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get(':slug')
  info(@Param('slug') slug: string) {
    return this.reservations.publicInfo(this.slugOf(slug));
  }

  @Get(':slug/availability')
  availability(@Param('slug') slug: string, @Query('date') date: string, @Query('party') party: string, @Req() req: any) {
    const clean = this.slugOf(slug);
    availabilityLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiadas consultas, esperá unos minutos');
    return this.reservations.publicAvailability(clean, String(date ?? ''), Number(party));
  }

  @Post(':slug/reservations')
  book(@Param('slug') slug: string, @Body() dto: BookDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    bookLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.reservations.publicBook(clean, dto);
  }

  @Post(':slug/reservations/cancel')
  cancel(@Param('slug') slug: string, @Body() dto: CancelDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    cancelLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.reservations.publicCancel(clean, dto.code, dto.phone);
  }

  @Post(':slug/waitlist')
  waitlist(@Param('slug') slug: string, @Body() dto: WaitlistDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    waitlistLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.reservations.publicWaitlist(clean, dto);
  }

  private slugOf(slug: string) {
    return SLUG.test(slug) ? slug : '-';
  }
}

// ---------------------------------------------------------------------------------------------
// Pantalla "Reservas" del restaurante (administrador y cajero)
// ---------------------------------------------------------------------------------------------
@Roles(Role.ADMIN, Role.CASHIER)
@Controller('api/reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  list(@TenantId() tenantId: string, @Query('date') date: string) {
    return this.reservations.listDay(tenantId, String(date ?? ''));
  }

  @Post()
  create(@TenantId() tenantId: string, @Body() dto: ManualBookDto) {
    return this.reservations.createManual(tenantId, dto);
  }

  @Patch('waitlist/:id')
  updateWaitlist(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: WaitlistStatusDto) {
    return this.reservations.updateWaitlist(tenantId, id, dto.status);
  }

  @Post('waitlist/:id/book')
  bookFromWaitlist(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: WaitlistBookDto) {
    return this.reservations.bookFromWaitlist(tenantId, id, dto.time);
  }

  @Patch(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateReservationDto) {
    return this.reservations.update(tenantId, id, dto);
  }
}
