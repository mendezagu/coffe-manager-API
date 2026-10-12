import { Controller, Get, Post, Delete, Body } from '@nestjs/common';
import { BalanceService } from './balance.service';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';

@Controller('api/balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Roles(Role.ADMIN, Role.CASHIER)
  @Get()
  async findAll() {
    try {
      return await this.balanceService.findAll();
    } catch (error) {
      throw error;
    }
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Post()
  async create(@Body() createBalanceDto: any) {
    try {
      return await this.balanceService.create(createBalanceDto);
    } catch (error) {
      throw error;
    }
  }

  @Roles(Role.ADMIN)
  @Delete()
  async removeAll() {
    try {
      return await this.balanceService.removeAll();
    } catch (error) {
      throw error;
    }
  }
}
