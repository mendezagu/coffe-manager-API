import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Table, TableDocument } from '../table/schemas/table.schema';
import { MenuItem, MenuItemDocument } from '../menu-item/schemas/menu-item.schema';
import { Waiter, WaiterDocument } from '../waiter/schemas/waiter.schema';

@Injectable()
export class TablesService {
  constructor(
    @InjectModel(Table.name) private tableModel: Model<TableDocument>,
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
    @InjectModel(Waiter.name) private waiterModel: Model<WaiterDocument>,
  ) {}

  async findAll(): Promise<Table[]> {
    const tables = await this.tableModel.find().exec();
    // Poblar waiterName dinámicamente si hay waiterId
    for (const table of tables) {
      if (table.waiterId) {
        const waiter = await this.waiterModel.findById(table.waiterId).exec();
        table.waiterName = waiter ? waiter.name : null;
      } else {
        table.waiterName = null;
      }
    }
    return tables;
  }

  async findOne(id: string): Promise<Table> {
    const table = await this.tableModel.findById(id).populate('orders.menuItem').exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return table;
  }

  async create(createTableDto: any): Promise<Table> {
    const newTable = new this.tableModel(createTableDto);
    return newTable.save();
  }

  async update(id: string, updateTableDto: any): Promise<Table> {
    const updatedTable = await this.tableModel.findByIdAndUpdate(id, updateTableDto, { new: true }).exec();
    if (!updatedTable) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return updatedTable;
  }

  async remove(id: string): Promise<{ message: string }> {
    const deletedTable = await this.tableModel.findByIdAndDelete(id).exec();
    if (!deletedTable) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return { message: 'Mesa eliminada' };
  }

  async addItems(id: string, items: any[]): Promise<Table> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    for (let item of items) {
      const menuItem = await this.menuItemModel.findById(item.id).exec();
      if (!menuItem) {
        throw new NotFoundException(`Ítem con ID ${item.id} no encontrado`);
      }

      const existingOrder = table.orders.find(order => order.menuItem.toString() === item.id);

      if (existingOrder) {
        existingOrder.quantity += item.quantity || 1;
      } else {
        table.orders.push({
          menuItem: menuItem._id as any,
          quantity: item.quantity || 1,
        });
      }
    }

    await table.save();
    const updatedTable = await this.tableModel.findById(id).populate('orders.menuItem').exec();
    return updatedTable;
  }

  async getWaiterByName(name: string): Promise<Waiter> {
    const waiter = await this.waiterModel.findOne({ name }).exec();
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return waiter;
  }

  async getWaiterById(id: string): Promise<Waiter> {
    const waiter = await this.waiterModel.findById(id).exec();
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return waiter;
  }

  async assignWaiter(id: string, waiterId: string, waiterName: string): Promise<{ message: string; table: Table }> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    table.waiterId = waiterId;
    table.waiterName = waiterName;
    await table.save();

    return { message: 'Mozo asignado correctamente', table };
  }

  async linkTables(id: string, linkedTableIds: string[]): Promise<{ message: string; table: Table }> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    for (let linkedTableId of linkedTableIds) {
      const linkedTable = await this.tableModel.findById(linkedTableId).exec();
      if (!linkedTable) {
        throw new NotFoundException(`Mesa con ID ${linkedTableId} no encontrada`);
      }

      linkedTable.controlledBy = id;
      linkedTable.available = false;
      await linkedTable.save();
    }

    table.linkedTables = linkedTableIds;
    await table.save();

    return { message: 'Mesas vinculadas correctamente', table };
  }

  async unlinkTables(id: string, linkedTableIds: string[]): Promise<{ message: string; table: Table }> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    for (let linkedTableId of linkedTableIds) {
      const linkedTable = await this.tableModel.findById(linkedTableId).exec();
      if (linkedTable) {
        linkedTable.controlledBy = undefined;
        linkedTable.available = true;
        await linkedTable.save();
      }
    }

    table.linkedTables = table.linkedTables.filter(id => !linkedTableIds.includes(id));
    await table.save();

    return { message: 'Mesas desvinculadas correctamente', table };
  }

  async removeOrder(id: string, orderIds: string[]): Promise<{ message: string; table: Table }> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    console.log('ID de la mesa:', id);
    console.log('Órdenes a eliminar:', orderIds);

    const ordersToKeep = table.orders.filter(order => !orderIds.includes((order as any)._id.toString()));
    console.log('Órdenes que quedan después de la eliminación:', ordersToKeep);

    table.orders = ordersToKeep;
    await table.save();

    return { message: 'Órdenes eliminadas correctamente', table };
  }

  async resetTable(id: string): Promise<{ message: string; table: Table }> {
    const table = await this.tableModel.findById(id).exec();
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    table.orders = [];

    for (let linkedTableId of table.linkedTables) {
      const linkedTable = await this.tableModel.findById(linkedTableId).exec();
      if (linkedTable) {
        linkedTable.controlledBy = undefined;
        linkedTable.available = true;
        await linkedTable.save();
      }
    }

    table.linkedTables = [];
    table.available = true;
    table.waiterId = undefined;
    table.waiterName = undefined;

    await table.save();

    return { message: 'Mesa reseteada correctamente', table };
  }
}
