import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { WaitersService } from './waiters.service';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';

@Controller('api/waiters')
export class WaitersController {
  constructor(private readonly waitersService: WaitersService) {}

  @Get()
  async findAll() {
    return await this.waitersService.findAll();
  }

  @Roles(Role.ADMIN)
  @Post()
  async create(@Body() createWaiterDto: any) {
    return await this.waitersService.create(createWaiterDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  async update(@Param('id') id: string, @Body() updateWaiterDto: any) {
    return await this.waitersService.update(id, updateWaiterDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return await this.waitersService.remove(id);
  }
}
