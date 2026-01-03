import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { MenuService } from './menu.service';

@Controller('api/menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  async findAll() {
    return await this.menuService.findAll();
  }

  @Post()
  async create(@Body() createMenuItemDto: any) {
    return await this.menuService.create(createMenuItemDto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() updateMenuItemDto: any) {
    return await this.menuService.update(id, updateMenuItemDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return await this.menuService.remove(id);
  }
}
