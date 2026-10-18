import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
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
  @IsString() @MinLength(1) @MaxLength(40) accessCode: string;
}

class ValidateVoucherDto {
  @IsString() @MinLength(1) @MaxLength(20) code: string;
}

const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// Frena a quien prueba códigos de hotel o llena de vouchers: por conexión y por hotel
const issueLimiter = new RateLimiter(10, 10 * 60 * 1000);

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
      accessCode: dto.accessCode,
    });
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
