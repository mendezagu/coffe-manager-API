import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { WaitersService } from './waiters.service';

@Controller('api/waiters')
export class WaitersController {
  constructor(private readonly waitersService: WaitersService) {}

  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.waitersService.findAll(tenantId);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@TenantId() tenantId: string, @Body() createWaiterDto: any) {
    return this.waitersService.create(tenantId, createWaiterDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() updateWaiterDto: any) {
    return this.waitersService.update(tenantId, id, updateWaiterDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.waitersService.remove(tenantId, id);
  }
}
