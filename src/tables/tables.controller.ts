import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { TablesService } from './tables.service';

@Controller('api/tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Get()
  async findAll() {
    try {
      return await this.tablesService.findAll();
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    try {
      return await this.tablesService.findOne(id);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Post()
  async create(@Body() createTableDto: any) {
    try {
      return await this.tablesService.create(createTableDto);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() updateTableDto: any) {
    try {
      return await this.tablesService.update(id, updateTableDto);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    try {
      return await this.tablesService.remove(id);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id/add-items')
  async addItems(@Param('id') id: string, @Body() body: { items: any[] }) {
    try {
      return await this.tablesService.addItems(id, body.items);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Get('waiter-by-name/:name')
  async getWaiterByName(@Param('name') name: string) {
    try {
      return await this.tablesService.getWaiterByName(name);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Get('waiter-by-id/:id')
  async getWaiterById(@Param('id') id: string) {
    try {
      return await this.tablesService.getWaiterById(id);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id/assign-waiter')
  async assignWaiter(@Param('id') id: string, @Body() body: { waiterId: string; waiterName: string }) {
    try {
      return await this.tablesService.assignWaiter(id, body.waiterId, body.waiterName);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id/link-tables')
  async linkTables(@Param('id') id: string, @Body() body: { linkedTableIds: string[] }) {
    try {
      return await this.tablesService.linkTables(id, body.linkedTableIds);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id/unlink-tables')
  async unlinkTables(@Param('id') id: string, @Body() body: { linkedTableIds: string[] }) {
    try {
      return await this.tablesService.unlinkTables(id, body.linkedTableIds);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  @Put(':id/remove-order')
  async removeOrder(@Param('id') id: string, @Body() body: { orderIds: string[] }) {
    try {
      return await this.tablesService.removeOrder(id, body.orderIds);
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }
  }

  @Put(':id/reset')
  async resetTable(@Param('id') id: string) {
    try {
      return await this.tablesService.resetTable(id);
    } catch (error) {
      console.error('Error al resetear la mesa:', error);
      throw error;
    }
  }
}
