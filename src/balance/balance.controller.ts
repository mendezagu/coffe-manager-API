import { Controller, Get, Post, Delete, Body } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { BalanceService } from './balance.service';

@Controller('api/balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.balanceService.findAll(tenantId);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post()
  create(@TenantId() tenantId: string, @Body() createBalanceDto: any) {
    return this.balanceService.create(tenantId, createBalanceDto);
  }

  @Roles(Role.ADMIN)
  @Delete()
  removeAll(@TenantId() tenantId: string) {
    return this.balanceService.removeAll(tenantId);
  }
}
