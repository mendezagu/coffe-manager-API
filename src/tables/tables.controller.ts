import { Controller, Get, Post, Put, Delete, Body, Param, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { TablesService } from './tables.service';

@Controller('api/tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.tablesService.findAll(tenantId);
  }

  @Get(':id')
  findOne(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.tablesService.findOne(tenantId, id);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@TenantId() tenantId: string, @Body() createTableDto: any) {
    return this.tablesService.create(tenantId, createTableDto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() updateTableDto: any) {
    return this.tablesService.update(tenantId, id, updateTableDto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.tablesService.remove(tenantId, id);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/add-items')
  addItems(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: { items: any[] }) {
    return this.tablesService.addItems(tenantId, id, body.items);
  }

  @Get('waiter-by-name/:name')
  getWaiterByName(@TenantId() tenantId: string, @Param('name') name: string) {
    return this.tablesService.getWaiterByName(tenantId, name);
  }

  @Get('waiter-by-id/:id')
  getWaiterById(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.tablesService.getWaiterById(tenantId, id);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/assign-waiter')
  assignWaiter(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { waiterId: string; waiterName: string },
  ) {
    return this.tablesService.assignWaiter(tenantId, id, body.waiterId, body.waiterName);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/link-tables')
  linkTables(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: { linkedTableIds: string[] }) {
    return this.tablesService.linkTables(tenantId, id, body.linkedTableIds);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/unlink-tables')
  unlinkTables(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: { linkedTableIds: string[] }) {
    return this.tablesService.unlinkTables(tenantId, id, body.linkedTableIds);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/update-quantities')
  updateQuantities(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Body() body: { updates: { orderId: string; quantity: number }[] },
  ) {
    return this.tablesService.updateOrderQuantities(tenantId, id, body.updates);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Put(':id/remove-order')
  removeOrder(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: { orderIds: string[] }, @Req() req: any) {
    // El administrador siempre puede; mozos y cajeros solo si el negocio lo habilitó en "Mi negocio"
    return this.tablesService.removeOrder(tenantId, id, body.orderIds, req.user.role);
  }

  @Roles(Role.ADMIN, Role.CASHIER)
  @Put(':id/reset')
  resetTable(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.tablesService.resetTable(tenantId, id);
  }
}
