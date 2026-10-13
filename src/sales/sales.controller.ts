import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { PAYMENT_METHODS, SalesService } from './sales.service';

class ItemDiscountDto {
  @IsString() orderId: string;
  @IsNumber() @Min(0) @Max(100) discount: number;
}

class PaymentDto {
  @IsIn(PAYMENT_METHODS as unknown as string[]) method: string;
  @IsNumber() @Min(0.01) amount: number;
  // solo efectivo: lo que entregó el cliente
  @IsOptional() @IsNumber() @Min(0) tendered?: number;
}

class LineDto {
  @IsString() orderId: string;
  @IsInt() @Min(1) quantity: number;
}

class CheckoutDto {
  @IsString() @MinLength(8) @MaxLength(100) checkoutId: string;
  // un solo método por el total (atajo); para varios métodos usar `payments`
  @IsOptional() @IsIn(PAYMENT_METHODS as unknown as string[]) paymentMethod?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments?: PaymentDto[];
  @IsOptional() @IsNumber() @Min(0) tip?: number;
  // cobrar solo una parte de la mesa (división de cuenta por platos)
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => LineDto) lines?: LineDto[];
  @IsOptional() @IsNumber() @Min(0) @Max(100) globalDiscount?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemDiscountDto)
  items?: ItemDiscountDto[];
}

// Historial de ventas (la pantalla de Balance)
@Controller('api/balances')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  // Solo el administrador: el historial muestra cómo se pagó cada venta y, sumando los cobros en efectivo,
  // permitiría reconstruir el efectivo esperado de una caja abierta (conteo a ciegas).
  @Roles(Role.ADMIN)
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.sales.findAll(tenantId);
  }

  @Roles(Role.ADMIN)
  @Get(':id')
  findOne(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.sales.findOne(tenantId, id);
  }

  @Roles(Role.ADMIN)
  @Delete()
  removeAll(@TenantId() tenantId: string) {
    return this.sales.removeAll(tenantId);
  }
}

// Cobrar una mesa: registra la venta y la libera en una sola operación
@Controller('api/tables')
export class CheckoutController {
  constructor(private readonly sales: SalesService) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post(':id/checkout')
  checkout(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: CheckoutDto, @Req() req: any) {
    return this.sales.checkout(tenantId, { id: req.user.id, name: req.user.name, role: req.user.role }, id, dto);
  }
}
