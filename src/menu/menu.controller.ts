import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { MenuService } from './menu.service';

@Controller('api/menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.menuService.findAll(tenantId);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@TenantId() tenantId: string, @Body() createMenuItemDto: any) {
    return this.menuService.create(tenantId, createMenuItemDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() updateMenuItemDto: any) {
    return this.menuService.update(tenantId, id, updateMenuItemDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.menuService.remove(tenantId, id);
  }
}
