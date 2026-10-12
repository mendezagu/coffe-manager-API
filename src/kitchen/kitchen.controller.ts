import { Body, Controller, Get, Param, Put, Query, Req } from '@nestjs/common';
import { Destination, OrderStatus, Role } from '@prisma/client';
import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { KitchenService } from './kitchen.service';

class SetStatusDto {
  @IsEnum(OrderStatus)
  status: OrderStatus;
}

class SetManyStatusDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids: string[];

  @IsEnum(OrderStatus)
  status: OrderStatus;
}

class ListQueryDto {
  @IsOptional()
  @IsEnum(Destination)
  destination?: Destination;
}

@Roles(Role.ADMIN, Role.KITCHEN, Role.BAR)
@Controller('api/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('orders')
  list(@TenantId() tenantId: string, @Req() req: any, @Query() query: ListQueryDto) {
    return this.kitchen.list(tenantId, req.user.role, query.destination);
  }

  // Cambia el estado de varias líneas a la vez (una comanda completa)
  @Put('orders/status')
  setManyStatus(@TenantId() tenantId: string, @Req() req: any, @Body() dto: SetManyStatusDto) {
    return this.kitchen.setManyStatus(tenantId, req.user.role, dto.ids, dto.status);
  }

  @Put('orders/:id/status')
  setStatus(@TenantId() tenantId: string, @Req() req: any, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.kitchen.setStatus(tenantId, req.user.role, id, dto.status);
  }
}
