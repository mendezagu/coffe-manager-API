import { MenuItem, Order, Sector, Table, Waiter } from '@prisma/client';

type OrderWithMenuItem = Order & { menuItem?: MenuItem | null };
type TableWithRelations = Table & {
  orders?: OrderWithMenuItem[];
  linkedTables?: Table[];
  waiter?: Waiter | null;
  sector?: Sector | null;
};

export function mapMenuItem(item: MenuItem) {
  return {
    _id: item.id,
    name: item.name,
    price: item.price,
    quantity: item.quantity,
    isPromo: item.isPromo,
    categoryId: item.categoryId ?? null,
  };
}

export function mapSector(sector: Sector) {
  return {
    _id: sector.id,
    name: sector.name,
    position: sector.position,
  };
}

export function mapWaiter(waiter: Waiter) {
  return {
    _id: waiter.id,
    name: waiter.name,
  };
}

// `populated` reproduces Mongoose's populate()-vs-not distinction: some
// endpoints returned orders.menuItem as a full object, others as a raw id.
export function mapOrder(order: OrderWithMenuItem, populated: boolean) {
  return {
    _id: order.id,
    menuItem: populated ? (order.menuItem ? mapMenuItem(order.menuItem) : null) : order.menuItemId,
    quantity: order.quantity,
    note: order.note,
    status: order.status,
  };
}

export function mapTable(table: TableWithRelations, opts: { populateOrders: boolean }) {
  return {
    _id: table.id,
    name: table.name,
    available: table.available,
    orders: (table.orders ?? []).map(o => mapOrder(o, opts.populateOrders)),
    linkedTables: (table.linkedTables ?? []).map(t => t.id),
    controlledBy: table.controlledById ?? null,
    waiterId: table.waiterId ?? null,
    waiterName: table.waiter ? table.waiter.name : null,
    sectorId: table.sectorId ?? null,
    sectorName: table.sector ? table.sector.name : null,
    sectorPosition: table.sector ? table.sector.position : null,
  };
}
