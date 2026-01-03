import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { WaitersService } from './waiters.service';

@Controller('api/waiters')
export class WaitersController {
  constructor(private readonly waitersService: WaitersService) {}

  @Get()
  async findAll() {
    return await this.waitersService.findAll();
  }

  @Post()
  async create(@Body() createWaiterDto: any) {
    return await this.waitersService.create(createWaiterDto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() updateWaiterDto: any) {
    return await this.waitersService.update(id, updateWaiterDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return await this.waitersService.remove(id);
  }
}
