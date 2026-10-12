import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
import { ArrayNotEmpty, IsArray, IsEnum, IsString } from 'class-validator';
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

@Roles(Role.ADMIN, Role.KITCHEN)
@Controller('api/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('orders')
  list(@TenantId() tenantId: string) {
    return this.kitchen.list(tenantId);
  }

  // Cambia el estado de varias líneas a la vez (una comanda completa)
  @Put('orders/status')
  setManyStatus(@TenantId() tenantId: string, @Body() dto: SetManyStatusDto) {
    return this.kitchen.setManyStatus(tenantId, dto.ids, dto.status);
  }

  @Put('orders/:id/status')
  setStatus(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: SetStatusDto) {
    return this.kitchen.setStatus(tenantId, id, dto.status);
  }
}
