import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { RateLimiter } from '../qr/rate-limit';
import { HotelsAdminService } from './hotels-admin.service';
import { PlatformTenantsService } from './platform-tenants.service';
import { PlatformAuthService, PlatformUserGuard } from './platform-auth';
import { HotelsService } from './hotels.service';

class UpdatePartnershipDto {
  @IsOptional() @IsNumber() @Min(0.01) @Max(100) discountPct?: number;
  @IsOptional() @IsString() @MaxLength(200) conditions?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

const SLUG = /^[a-z0-9-]{1,60}$/;

class IssueVoucherDto {
  @IsString() @Matches(/^[\w-]{1,64}$/) restaurantId: string;
  @IsString() @MinLength(2) @MaxLength(60) guestName: string;
  // DNI o pasaporte: con o sin puntos y espacios (el servidor lo normaliza y lo valida)
  @IsString() @MinLength(5) @MaxLength(25) document: string;
  @IsString() @MinLength(1) @MaxLength(40) accessCode: string;
}

class HotelReserveDto {
  @IsString() @Matches(/^[\w-]{1,64}$/) restaurantId: string;
  @IsString() @MinLength(1) @MaxLength(40) accessCode: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsString() @Matches(/^\d{2}:\d{2}$/) time: string;
  @IsInt() @Min(1) @Max(100) partySize: number;
  @IsString() @MinLength(2) @MaxLength(60) guestName: string;
  @IsString() @MinLength(6) @MaxLength(25) guestPhone: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @IsOptional() @IsBoolean() wantVoucher?: boolean;
  @IsOptional() @IsString() @MaxLength(25) document?: string;
}

class HotelWaitlistDto {
  @IsString() @Matches(/^[\w-]{1,64}$/) restaurantId: string;
  @IsString() @MinLength(1) @MaxLength(40) accessCode: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) date: string;
  @IsString() @Matches(/^\d{2}:\d{2}$/) fromTime: string;
  @IsString() @Matches(/^\d{2}:\d{2}$/) toTime: string;
  @IsInt() @Min(1) @Max(100) partySize: number;
  @IsString() @MinLength(2) @MaxLength(60) guestName: string;
  @IsString() @MinLength(6) @MaxLength(25) guestPhone: string;
}

class VoucherStatusDto {
  // Los códigos que ya tiene el celular del huésped (de 6 caracteres; se aceptan con espacios o guiones)
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Matches(/^[A-Za-z0-9 -]{4,12}$/, { each: true }) codes: string[];
}

class ValidateVoucherDto {
  @IsString() @MinLength(1) @MaxLength(20) code: string;
}

const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// Frena a quien prueba códigos de hotel o llena de vouchers: por conexión y por hotel
const issueLimiter = new RateLimiter(10, 10 * 60 * 1000);
// Consultar el estado de vouchers: también limitado, para que no sirva para probar códigos al azar
const statusLimiter = new RateLimiter(20, 10 * 60 * 1000);
// Reservas desde el hotel: por conexión y por hotel, para que no se use para llenar un restaurante de reservas
const reserveLimiter = new RateLimiter(8, 10 * 60 * 1000);
const availabilityLimiter = new RateLimiter(60, 10 * 60 * 1000);

// ---------------------------------------------------------------------------------------------
// Pantalla del huésped. Sin sesión: el acceso lo da el código vigente que el hotel le entrega.
// ---------------------------------------------------------------------------------------------
@Public()
@Controller('api/public/hotel')
export class HotelsPublicController {
  constructor(private readonly hotels: HotelsService) {}

  @Get(':slug')
  info(@Param('slug') slug: string) {
    return this.hotels.publicInfo(this.slugOf(slug));
  }

  @Post(':slug/vouchers')
  issue(@Param('slug') slug: string, @Body() dto: IssueVoucherDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    issueLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.hotels.issueVoucher(clean, {
      tenantId: dto.restaurantId,
      guestName: dto.guestName,
      document: dto.document,
      accessCode: dto.accessCode,
    });
  }

  // Horarios con lugar para reservar en un restaurante adherido
  @Get(':slug/reservations/availability')
  reservationAvailability(
    @Param('slug') slug: string,
    @Query('restaurantId') restaurantId: string,
    @Query('date') date: string,
    @Query('party') party: string,
    @Req() req: any,
  ) {
    const clean = this.slugOf(slug);
    availabilityLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiadas consultas, esperá unos minutos');
    return this.hotels.reservationAvailability(clean, String(restaurantId ?? ''), String(date ?? ''), Number(party));
  }

  // Reservar mesa (con o sin voucher)
  @Post(':slug/reservations')
  reserve(@Param('slug') slug: string, @Body() dto: HotelReserveDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    reserveLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.hotels.reserve(clean, {
      tenantId: dto.restaurantId,
      accessCode: dto.accessCode,
      date: dto.date,
      time: dto.time,
      partySize: dto.partySize,
      guestName: dto.guestName,
      guestPhone: dto.guestPhone,
      notes: dto.notes,
      wantVoucher: dto.wantVoucher,
      document: dto.document,
    });
  }

  @Post(':slug/reservations/waitlist')
  reserveWaitlist(@Param('slug') slug: string, @Body() dto: HotelWaitlistDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    reserveLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiados intentos, esperá unos minutos');
    return this.hotels.reserveWaitlist(clean, { ...dto, tenantId: dto.restaurantId });
  }

  // Estado (vigente, canjeado, vencido o anulado) de los vouchers que el huésped ya tiene en su celular
  @Post(':slug/vouchers/status')
  statuses(@Param('slug') slug: string, @Body() dto: VoucherStatusDto, @Req() req: any) {
    const clean = this.slugOf(slug);
    statusLimiter.hit(`${ipOf(req)}:${clean}`, 'Demasiadas consultas, esperá unos minutos');
    return this.hotels.voucherStatuses(clean, dto.codes);
  }

  private slugOf(slug: string) {
    return SLUG.test(slug) ? slug : '-';
  }
}

// ---------------------------------------------------------------------------------------------
// Lado del restaurante (cajero / administrador)
// ---------------------------------------------------------------------------------------------
@Controller('api/hotels')
export class HotelsController {
  constructor(
    private readonly hotels: HotelsService,
    private readonly admin: HotelsAdminService,
  ) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('vouchers/validate')
  validate(@TenantId() tenantId: string, @Body() dto: ValidateVoucherDto) {
    return this.hotels.validate(tenantId, dto.code);
  }

  // Los hoteles a los que el negocio está adherido, con su descuento
  @Roles(Role.ADMIN)
  @Get('partnerships')
  partnerships(@TenantId() tenantId: string) {
    return this.admin.listPartnerships(tenantId);
  }

  @Roles(Role.ADMIN)
  @Patch('partnerships/:id')
  updatePartnership(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdatePartnershipDto) {
    return this.admin.updatePartnership(tenantId, id, dto);
  }
}

// ---------------------------------------------------------------------------------------------
// Consola de plataforma (el dueño de Tavolapp): alta de restaurantes y hoteles, y vínculos entre ellos
// ---------------------------------------------------------------------------------------------
class HotelDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(60) slug?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) accessCode?: string;
  @IsOptional() @IsString() @MaxLength(200) contact?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(60) voucherValidDays?: number;
}

class TenantDto {
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  @IsString() @MaxLength(200) adminEmail: string;
  @IsOptional() @IsString() @MaxLength(100) adminName?: string;
  @IsString() @MinLength(8) @MaxLength(100) password: string;
  @IsOptional() @IsString() @MaxLength(20) plan?: string;
}

class HotelUserDto {
  @IsString() @MaxLength(200) email: string;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsString() @MinLength(8) @MaxLength(100) password: string;
}

class UpdateHotelUserDto {
  @IsOptional() @IsString() @MinLength(8) @MaxLength(100) password?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
}

class PartnerDto {
  @IsString() @Matches(/^[\w-]{1,64}$/) tenantId: string;
  @IsNumber() @Min(0.01) @Max(100) discountPct: number;
  @IsOptional() @IsString() @MaxLength(200) conditions?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class PlatformLoginDto {
  @IsString() @MaxLength(200) email: string;
  @IsString() @MaxLength(200) password: string;
}

const platformLoginLimiter = new RateLimiter(10, 10 * 60 * 1000);

// Login de la consola de plataforma (cuenta propia, separada de los restaurantes y los hoteles)
@Public()
@Controller('api/platform-auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  login(@Body() dto: PlatformLoginDto, @Req() req: any) {
    platformLoginLimiter.hit(ipOf(req), 'Demasiados intentos, esperá unos minutos');
    return this.auth.login(dto.email, dto.password);
  }

  @UseGuards(PlatformUserGuard)
  @Get('me')
  me(@Req() req: any) {
    return req.platformUser;
  }
}

// @Public() solo saca estas rutas del login del personal de los restaurantes; las protege PlatformUserGuard
@Public()
@UseGuards(PlatformUserGuard)
@Controller('api/platform')
export class HotelsPlatformController {
  constructor(
    private readonly admin: HotelsAdminService,
    private readonly tenantsAdmin: PlatformTenantsService,
  ) {}

  @Get('hotels')
  list() {
    return this.admin.listHotels();
  }

  @Get('tenants')
  tenants() {
    return this.tenantsAdmin.list();
  }

  // Alta de un restaurante con su administrador
  @Post('tenants')
  createTenant(@Body() dto: TenantDto) {
    return this.tenantsAdmin.create(dto);
  }

  @Post('hotels/:id/users')
  createHotelUser(@Param('id') id: string, @Body() dto: HotelUserDto) {
    return this.admin.createHotelUser(id, dto);
  }

  @Patch('hotel-users/:id')
  updateHotelUser(@Param('id') id: string, @Body() dto: UpdateHotelUserDto) {
    return this.admin.updateHotelUser(id, dto);
  }

  @Post('hotels')
  create(@Body() dto: HotelDto) {
    return this.admin.createHotel(dto);
  }

  @Patch('hotels/:id')
  update(@Param('id') id: string, @Body() dto: HotelDto) {
    return this.admin.updateHotel(id, dto);
  }

  @Put('hotels/:id/partners')
  setPartner(@Param('id') id: string, @Body() dto: PartnerDto) {
    return this.admin.setPartner(id, dto);
  }
}
