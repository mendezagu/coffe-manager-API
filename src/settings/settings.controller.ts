import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { SettingsService } from './settings.service';

class UpdateSettingsDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(40) loginCode?: string;
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
  @IsOptional() @IsString() @Matches(/^#[0-9a-fA-F]{6}$/) brandColor?: string;
  @IsOptional() @IsString() @MaxLength(3) currencyCode?: string;
  @IsOptional() @IsString() @MaxLength(15) locale?: string;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftMorningStart?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftAfternoonStart?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) shiftNightStart?: number;
  @IsOptional() @IsBoolean() kitchenEnabled?: boolean;
  @IsOptional() @IsBoolean() splitKitchenBar?: boolean;
  @IsOptional() @IsBoolean() cashierDiscounts?: boolean;
  @IsOptional() @IsBoolean() waiterCanRemoveItems?: boolean;
  @IsOptional() @IsBoolean() cashierCanRemoveItems?: boolean;
  @IsOptional() @IsBoolean() tipEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) tipSuggestedPct?: number;
  @IsOptional() @IsBoolean() commissionEnabled?: boolean;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) commissionPct?: number;
  @IsOptional() @IsBoolean() reservationsEnabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1439) reservationOpenMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1439) reservationCloseMin?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(7) @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true }) reservationDays?: number[];
  @IsOptional() @IsInt() @Min(5) @Max(120) reservationSlotMin?: number;
  @IsOptional() @IsInt() @Min(15) @Max(600) reservationDurationMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) reservationCapacity?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1000) reservationMaxParty?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) reservationAdvanceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) reservationNoticeMin?: number;
  @IsOptional() @IsBoolean() requireOpenRegister?: boolean;
  @IsOptional() @IsBoolean() inventoryEnabled?: boolean;
  @IsOptional() @IsBoolean() blockOutOfStock?: boolean;
  @IsOptional() @IsBoolean() qrEnabled?: boolean;
  @IsOptional() @IsBoolean() qrAutoConfirm?: boolean;
  @IsOptional() @IsBoolean() qrRequirePin?: boolean;
  @IsOptional() @IsBoolean() onboardingDone?: boolean;
}

// Turno en curso: es del negocio, no de cada dispositivo (así todos ven lo mismo)
@Controller('api/shift')
export class ShiftController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@TenantId() tenantId: string) {
    return this.settings.shift(tenantId);
  }

  @Roles(Role.ADMIN)
  @Post('start')
  start(@TenantId() tenantId: string) {
    return this.settings.startShift(tenantId);
  }
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
