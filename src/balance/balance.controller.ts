import { Controller, Get, Post, Delete, Body } from '@nestjs/common';
import { BalanceService } from './balance.service';

@Controller('api/balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get()
  async findAll() {
    try {
      return await this.balanceService.findAll();
    } catch (error) {
      throw error;
    }
  }

  @Post()
  async create(@Body() createBalanceDto: any) {
    try {
      return await this.balanceService.create(createBalanceDto);
    } catch (error) {
      throw error;
    }
  }

  @Delete()
  async removeAll() {
    try {
      return await this.balanceService.removeAll();
    } catch (error) {
      throw error;
    }
  }
}
