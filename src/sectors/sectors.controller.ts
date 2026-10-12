import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { SectorsService } from './sectors.service';

@Controller('api/sectors')
export class SectorsController {
  constructor(private readonly sectorsService: SectorsService) {}

  @Get()
  async findAll() {
    return await this.sectorsService.findAll();
  }

  // Debe ir antes de ':id' para que "reorder" no se interprete como un id
  @Put('reorder')
  async reorder(@Body() reorderSectorsDto: any) {
    return await this.sectorsService.reorder(reorderSectorsDto?.ids);
  }

  @Post()
  async create(@Body() createSectorDto: any) {
    return await this.sectorsService.create(createSectorDto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() updateSectorDto: any) {
    return await this.sectorsService.update(id, updateSectorDto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return await this.sectorsService.remove(id);
  }
}
