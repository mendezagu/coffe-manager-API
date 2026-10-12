import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { SectorsService } from './sectors.service';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';

@Controller('api/sectors')
export class SectorsController {
  constructor(private readonly sectorsService: SectorsService) {}

  @Get()
  async findAll() {
    return await this.sectorsService.findAll();
  }

  // Debe ir antes de ':id' para que "reorder" no se interprete como un id
  @Roles(Role.ADMIN)
  @Put('reorder')
  async reorder(@Body() reorderSectorsDto: any) {
    return await this.sectorsService.reorder(reorderSectorsDto?.ids);
  }

  @Roles(Role.ADMIN)
  @Post()
  async create(@Body() createSectorDto: any) {
    return await this.sectorsService.create(createSectorDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  async update(@Param('id') id: string, @Body() updateSectorDto: any) {
    return await this.sectorsService.update(id, updateSectorDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return await this.sectorsService.remove(id);
  }
}
