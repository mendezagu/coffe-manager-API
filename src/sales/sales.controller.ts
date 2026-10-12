import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
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

class CheckoutDto {
  @IsString() @MinLength(8) @MaxLength(100) checkoutId: string;
  @IsIn(PAYMENT_METHODS as unknown as string[]) paymentMethod: string;
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

  @Roles(Role.ADMIN, Role.CASHIER)
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.sales.findAll(tenantId);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
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
