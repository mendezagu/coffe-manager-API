import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { SectorsService } from './sectors.service';

@Controller('api/sectors')
export class SectorsController {
  constructor(private readonly sectorsService: SectorsService) {}

  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.sectorsService.findAll(tenantId);
  }

  // Debe ir antes de ':id' para que "reorder" no se interprete como un id
  @Roles(Role.ADMIN)
  @Put('reorder')
  reorder(@TenantId() tenantId: string, @Body() reorderSectorsDto: any) {
    return this.sectorsService.reorder(tenantId, reorderSectorsDto?.ids);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@TenantId() tenantId: string, @Body() createSectorDto: any) {
    return this.sectorsService.create(tenantId, createSectorDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() updateSectorDto: any) {
    return this.sectorsService.update(tenantId, id, updateSectorDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.sectorsService.remove(tenantId, id);
  }
}
