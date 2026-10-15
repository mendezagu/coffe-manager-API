import { Body, Controller, Get, Put } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { SettingsService } from './settings.service';

class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(120) legalName?: string;
  @IsOptional() @IsString() @MaxLength(20) taxIdLabel?: string;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string;
  @IsOptional() @IsString() @MaxLength(120) address?: string;
  @IsOptional() @IsString() @MaxLength(80) city?: string;
  @IsOptional() @IsString() @MaxLength(20) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(300) ticketFooter?: string;
  // ~400 KB como máximo; el frontend achica la imagen antes de enviarla
  @IsOptional() @IsString() @MaxLength(400_000) logoUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(3) currencyCode?: string;
  @IsOptional() @IsString() @MaxLength(15) locale?: string;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftMorningStart?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftAfternoonStart?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftNightStart?: number;
  @IsOptional() @IsBoolean() kitchenEnabled?: boolean;
  @IsOptional() @IsBoolean() splitKitchenBar?: boolean;
  @IsOptional() @IsBoolean() cashierDiscounts?: boolean;
  @IsOptional() @IsBoolean() staffCanRemoveItems?: boolean;
  @IsOptional() @IsBoolean() tipEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) tipSuggestedPct?: number;
  @IsOptional() @IsBoolean() requireOpenRegister?: boolean;
  @IsOptional() @IsBoolean() inventoryEnabled?: boolean;
  @IsOptional() @IsBoolean() blockOutOfStock?: boolean;
  @IsOptional() @IsBoolean() qrEnabled?: boolean;
  @IsOptional() @IsBoolean() qrAutoConfirm?: boolean;
  @IsOptional() @IsBoolean() qrRequirePin?: boolean;
}

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  // Lo necesitan todos los roles: nombre, logo y moneda se usan en toda la app.
  @Get()
  get(@TenantId() tenantId: string) {
    return this.settings.get(tenantId);
  }

  @Roles(Role.ADMIN)
  @Put()
  update(@TenantId() tenantId: string, @Body() dto: UpdateSettingsDto) {
    return this.settings.update(tenantId, dto);
  }
}
