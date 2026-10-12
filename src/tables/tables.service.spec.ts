import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from './tables.service';

// Corre contra una base Postgres real y separada (coffee_manager_test), no
// contra la base de desarrollo (que tiene los datos migrados de producción).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('TablesService', () => {
  let prisma: PrismaService;
  let service: TablesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new TablesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // orden FK-safe: orders -> tables/menuItems/waiters -> balances (no relacionado)
    await prisma.order.deleteMany({});
    await prisma.table.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.waiter.deleteMany({});
    await prisma.balance.deleteMany({});
  });

  describe('addItems', () => {
    it('fusiona en la misma línea cuando el ítem y la nota coinciden (ambas vacías)', async () => {
      const table = await prisma.table.create({ data: { name: 'Mesa 1' } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });

      await service.addItems(table.id, [{ id: item.id, quantity: 1 }]);
      const result = await service.addItems(table.id, [{ id: item.id, quantity: 2 }]);

      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].quantity).toBe(3);
    });

    it('crea una línea nueva cuando el ítem coincide pero la nota es distinta', async () => {
      const table = await prisma.table.create({ data: { name: 'Mesa 1' } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });

      await service.addItems(table.id, [{ id: item.id, quantity: 1 }]);
      const result = await service.addItems(table.id, [{ id: item.id, quantity: 1, note: 'sin azúcar' }]);

      expect(result.orders).toHaveLength(2);
    });

    it('nunca fusiona líneas que ya tienen nota, aunque la nueva también venga sin nota', async () => {
      const table = await prisma.table.create({ data: { name: 'Mesa 1' } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });

      await service.addItems(table.id, [{ id: item.id, quantity: 1, note: 'sin azúcar' }]);
      const result = await service.addItems(table.id, [{ id: item.id, quantity: 1 }]);

      expect(result.orders).toHaveLength(2);
    });
  });

  describe('linkTables / unlinkTables', () => {
    it('linkTables tira 404 si una mesa vinculada no existe', async () => {
      const parent = await prisma.table.create({ data: { name: 'Mesa Padre' } });

      await expect(service.linkTables(parent.id, ['id-inexistente'])).rejects.toThrow(NotFoundException);
    });

    it('unlinkTables ignora en silencio una mesa que nunca estuvo vinculada', async () => {
      const parent = await prisma.table.create({ data: { name: 'Mesa Padre' } });

      await expect(service.unlinkTables(parent.id, ['id-inexistente'])).resolves.toBeDefined();
    });

    it('linkTables marca la mesa hija como controlada y no disponible', async () => {
      const parent = await prisma.table.create({ data: { name: 'Mesa Padre' } });
      const child = await prisma.table.create({ data: { name: 'Mesa Hija' } });

      const result = await service.linkTables(parent.id, [child.id]);

      expect(result.table.linkedTables).toContain(child.id);
      const updatedChild = await prisma.table.findUnique({ where: { id: child.id } });
      expect(updatedChild?.controlledById).toBe(parent.id);
      expect(updatedChild?.available).toBe(false);
    });
  });

  describe('updateOrderQuantities / removeOrder', () => {
    it('no permite modificar una orden de otra mesa a través de este endpoint', async () => {
      const tableA = await prisma.table.create({ data: { name: 'Mesa A' } });
      const tableB = await prisma.table.create({ data: { name: 'Mesa B' } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });
      const orderInB = await prisma.order.create({ data: { tableId: tableB.id, menuItemId: item.id, quantity: 1 } });

      await service.updateOrderQuantities(tableA.id, [{ orderId: orderInB.id, quantity: 99 }]);

      const untouched = await prisma.order.findUnique({ where: { id: orderInB.id } });
      expect(untouched?.quantity).toBe(1);
    });

    it('no permite borrar una orden de otra mesa a través de este endpoint', async () => {
      const tableA = await prisma.table.create({ data: { name: 'Mesa A' } });
      const tableB = await prisma.table.create({ data: { name: 'Mesa B' } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });
      const orderInB = await prisma.order.create({ data: { tableId: tableB.id, menuItemId: item.id, quantity: 1 } });

      await service.removeOrder(tableA.id, [orderInB.id]);

      const stillThere = await prisma.order.findUnique({ where: { id: orderInB.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  describe('resetTable', () => {
    it('vacía los pedidos y libera las mesas vinculadas', async () => {
      const parent = await prisma.table.create({ data: { name: 'Mesa Padre' } });
      const child = await prisma.table.create({ data: { name: 'Mesa Hija', controlledById: parent.id, available: false } });
      const item = await prisma.menuItem.create({ data: { name: 'Café', price: 100 } });
      await prisma.order.create({ data: { tableId: parent.id, menuItemId: item.id, quantity: 1 } });

      const result = await service.resetTable(parent.id);

      expect(result.table.orders).toHaveLength(0);
      expect(result.table.available).toBe(true);
      const updatedChild = await prisma.table.findUnique({ where: { id: child.id } });
      expect(updatedChild?.controlledById).toBeNull();
      expect(updatedChild?.available).toBe(true);
    });
  });
});
