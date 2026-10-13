import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CashMovementType, Role } from '@prisma/client';
import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { CashActor, CashService } from './cash.service';

class OpenDto {
  @IsNumber() @Min(0) openingAmount: number;
}

class MovementDto {
  @IsEnum(CashMovementType) type: CashMovementType;
  @IsNumber() @Min(0.01) amount: number;
  @IsString() @MaxLength(120) reason: string;
}

class CloseDto {
  @IsNumber() @Min(0) countedAmount: number;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

const actorOf = (req: any): CashActor => ({ id: req.user.id, name: req.user.name, role: req.user.role });

// Caja: la maneja quien cobra. El historial completo es solo del administrador.
@Controller('api/cash')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Get('current')
  current(@TenantId() tenantId: string, @Req() req: any) {
    return this.cash.current(tenantId, req.user.role);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('open')
  open(@TenantId() tenantId: string, @Req() req: any, @Body() dto: OpenDto) {
    return this.cash.open(tenantId, actorOf(req), dto.openingAmount);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('movements')
  addMovement(@TenantId() tenantId: string, @Req() req: any, @Body() dto: MovementDto) {
    return this.cash.addMovement(tenantId, actorOf(req), dto);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post('close')
  close(@TenantId() tenantId: string, @Req() req: any, @Body() dto: CloseDto) {
    return this.cash.close(tenantId, actorOf(req), dto);
  }

  @Roles(Role.ADMIN)
  @Get('registers')
  history(@TenantId() tenantId: string) {
    return this.cash.history(tenantId);
  }

  @Roles(Role.ADMIN)
  @Get('registers/:id')
  detail(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.cash.detail(tenantId, id);
  }
}
