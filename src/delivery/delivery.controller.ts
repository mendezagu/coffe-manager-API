import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { DeliveryService } from './delivery.service';
import { PAYMENT_METHODS } from '../sales/sales.service';

const ID = /^[\w-]{1,64}$/;

class OrderLineDto {
  @IsString() @Matches(ID) menuItemId: string;
  @IsInt() @Min(1) @Max(30) quantity: number;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Matches(ID, { each: true }) optionIds?: string[];
}

class CreateOrderDto {
  // Lo genera el celular y se guarda ahí
  @IsString() @Matches(/^[\w-]{8,64}$/) clientId: string;
  @IsString() @MinLength(2) @MaxLength(60) customerName: string;
  @IsString() @Matches(/^[\d+()\s-]{6,25}$/, { message: 'Escribí un teléfono válido' }) phone: string;
  @IsIn(['pickup', 'delivery']) mode: 'pickup' | 'delivery';
  @IsOptional() @IsString() @MaxLength(160) address?: string;
  @IsIn(['cash', 'transfer']) payMethod: 'cash' | 'transfer';
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => OrderLineDto) items: OrderLineDto[];
}

class RejectDto {
  @IsOptional() @IsString() @MaxLength(140) reason?: string;
}

class CompleteDto {
  @IsOptional() @IsIn(PAYMENT_METHODS as unknown as string[]) paymentMethod?: string;
}

// La conexión del cliente (detrás del proxy del hosting, Express ya devuelve la IP real con `trust proxy`)
const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// Tienda online: abierta a cualquiera con el link, sin sesión. Solo muestra la carta y recibe pedidos.
@Public()
@Controller('api/public/delivery')
export class DeliveryPublicController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get(':slug')
  info(@Param('slug') slug: string, @Req() req: any) {
    return this.delivery.info(slug, ipOf(req));
  }

  @Post(':slug/orders')
  create(@Param('slug') slug: string, @Req() req: any, @Body() dto: CreateOrderDto) {
    return this.delivery.create(slug, ipOf(req), dto);
  }

  @Get(':slug/orders/:token')
  track(@Param('slug') slug: string, @Param('token') token: string, @Req() req: any) {
    return this.delivery.track(slug, ipOf(req), token);
  }

  @Post(':slug/orders/:token/cancel')
  cancel(@Param('slug') slug: string, @Param('token') token: string, @Req() req: any) {
    return this.delivery.cancelByClient(slug, ipOf(req), token);
  }
}

// Personal del local: bandeja de pedidos de la tienda
@Controller('api/delivery')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Get('orders')
  list(@TenantId() tenantId: string) {
    return this.delivery.list(tenantId);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('orders/:id/accept')
  accept(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.delivery.accept(tenantId, id);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('orders/:id/ready')
  ready(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.delivery.ready(tenantId, id);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('orders/:id/reject')
  reject(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any, @Body() dto: RejectDto) {
    return this.delivery.reject(tenantId, id, dto.reason ?? '', { id: req.user.id, name: req.user.name });
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('orders/:id/complete')
  complete(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any, @Body() dto: CompleteDto) {
    return this.delivery.complete(tenantId, id, { id: req.user.id, name: req.user.name }, dto.paymentMethod);
  }
}
