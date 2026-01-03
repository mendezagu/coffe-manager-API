import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TablesController } from './tables.controller';
import { TablesService } from './tables.service';
import { Table, TableSchema } from '../table/schemas/table.schema';
import { MenuItem, MenuItemSchema } from '../menu-item/schemas/menu-item.schema';
import { Waiter, WaiterSchema } from '../waiter/schemas/waiter.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Table.name, schema: TableSchema },
      { name: MenuItem.name, schema: MenuItemSchema },
      { name: Waiter.name, schema: WaiterSchema },
    ]),
  ],
  controllers: [TablesController],
  providers: [TablesService],
})
export class TablesModule {}
