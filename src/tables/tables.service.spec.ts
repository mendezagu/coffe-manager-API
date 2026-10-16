import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
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
  let tenantId: string; // el negocio con el que trabajan los tests
  let otherTenantId: string; // un negocio ajeno, para probar el aislamiento

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new TablesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Borrar los negocios arrastra todo lo suyo (onDelete: Cascade): mesas, órdenes, menú, mozos...
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A' } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Negocio B' } })).id;
  });

  const newTable = (name: string, extra: object = {}, tid = tenantId) =>
    prisma.table.create({ data: { name, tenantId: tid, ...extra } });
  const newItem = (name = 'Café', tid = tenantId) =>
    prisma.menuItem.create({ data: { name, price: 100, tenantId: tid } });

  describe('addItems', () => {
    it('registra la hora de apertura con el primer pedido y no la cambia con los siguientes', async () => {
      const table = await newTable('Mesa 1');
      const item = await newItem();
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toBeNull();

      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);
      const first = (await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt;
      expect(first).not.toBeNull();

      await new Promise((r) => setTimeout(r, 20));
      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1, note: 'otro' }]);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toEqual(first);
    });

    it('un pedido que falla no deja la mesa marcada como abierta', async () => {
      const table = await newTable('Mesa 1');
      await expect(service.addItems(tenantId, table.id, [{ id: 'no-existe', quantity: 1 }])).rejects.toThrow();
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toBeNull();
    });

    it('fusiona en la misma línea cuando el ítem y la nota coinciden (ambas vacías)', async () => {
      const table = await newTable('Mesa 1');
      const item = await newItem();

      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);
      const result = await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 2 }]);

      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].quantity).toBe(3);
    });

    it('crea una línea nueva cuando el ítem coincide pero la nota es distinta', async () => {
      const table = await newTable('Mesa 1');
      const item = await newItem();

      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);
      const result = await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1, note: 'sin azúcar' }]);

      expect(result.orders).toHaveLength(2);
    });

    it('nunca fusiona líneas que ya tienen nota, aunque la nueva también venga sin nota', async () => {
      const table = await newTable('Mesa 1');
      const item = await newItem();

      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1, note: 'sin azúcar' }]);
      const result = await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);

      expect(result.orders).toHaveLength(2);
    });

    it('no suma a una línea que cocina ya tomó: crea una nueva pendiente', async () => {
      const table = await newTable('Mesa 1');
      const item = await newItem();

      await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);
      await prisma.order.updateMany({ where: { tableId: table.id }, data: { status: 'PREPARING' } });
      const result = await service.addItems(tenantId, table.id, [{ id: item.id, quantity: 1 }]);

      expect(result.orders).toHaveLength(2);
    });
  });

  describe('linkTables / unlinkTables', () => {
    it('linkTables tira 404 si una mesa vinculada no existe', async () => {
      const parent = await newTable('Mesa Padre');

      await expect(service.linkTables(tenantId, parent.id, ['id-inexistente'])).rejects.toThrow(NotFoundException);
    });

    it('unlinkTables ignora en silencio una mesa que nunca estuvo vinculada', async () => {
      const parent = await newTable('Mesa Padre');

      await expect(service.unlinkTables(tenantId, parent.id, ['id-inexistente'])).resolves.toBeDefined();
    });

    it('linkTables marca la mesa hija como controlada y no disponible', async () => {
      const parent = await newTable('Mesa Padre');
      const child = await newTable('Mesa Hija');

      const result = await service.linkTables(tenantId, parent.id, [child.id]);

      expect(result.table.linkedTables).toContain(child.id);
      const updatedChild = await prisma.table.findUnique({ where: { id: child.id } });
      expect(updatedChild?.controlledById).toBe(parent.id);
      expect(updatedChild?.available).toBe(false);
    });
  });

  describe('eliminar ítems según el rol', () => {
    async function tableWithLine() {
      const table = await newTable('Mesa 1');
      const item = await newItem();
      const order = await prisma.order.create({ data: { tableId: table.id, menuItemId: item.id, quantity: 1 } });
      return { table, order };
    }

    it('el administrador siempre puede, aunque la opción esté apagada', async () => {
      const { table, order } = await tableWithLine();
      await service.removeOrder(tenantId, table.id, [order.id], Role.ADMIN);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(0);
    });

    it('mozo y cajero no pueden si el negocio no lo habilitó', async () => {
      const { table, order } = await tableWithLine();
      await expect(service.removeOrder(tenantId, table.id, [order.id], Role.WAITER)).rejects.toThrow(ForbiddenException);
      await expect(service.removeOrder(tenantId, table.id, [order.id], Role.CASHIER)).rejects.toThrow(/No tenés permiso/);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(1);
    });

    it('se puede habilitar solo a los mozos: el cajero sigue sin poder', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { waiterCanRemoveItems: true } });
      const { table, order } = await tableWithLine();
      await expect(service.removeOrder(tenantId, table.id, [order.id], Role.CASHIER)).rejects.toThrow(ForbiddenException);
      await service.removeOrder(tenantId, table.id, [order.id], Role.WAITER);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(0);
    });

    it('se puede habilitar solo a los cajeros: el mozo sigue sin poder', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { cashierCanRemoveItems: true } });
      const { table, order } = await tableWithLine();
      await expect(service.removeOrder(tenantId, table.id, [order.id], Role.WAITER)).rejects.toThrow(ForbiddenException);
      await service.removeOrder(tenantId, table.id, [order.id], Role.CASHIER);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(0);
    });

    it('con los dos habilitados, ambos pueden', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { waiterCanRemoveItems: true, cashierCanRemoveItems: true } });
      const { table, order } = await tableWithLine();
      const second = await prisma.order.create({ data: { tableId: table.id, menuItemId: order.menuItemId, quantity: 1, note: 'otro' } });
      await service.removeOrder(tenantId, table.id, [order.id], Role.WAITER);
      await service.removeOrder(tenantId, table.id, [second.id], Role.CASHIER);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(0);
    });

    it('la opción de un negocio no habilita a los de otro', async () => {
      await prisma.tenant.update({ where: { id: otherTenantId }, data: { waiterCanRemoveItems: true, cashierCanRemoveItems: true } });
      const { table, order } = await tableWithLine();
      await expect(service.removeOrder(tenantId, table.id, [order.id], Role.WAITER)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('updateOrderQuantities / removeOrder', () => {
    it('no permite modificar una orden de otra mesa a través de este endpoint', async () => {
      const tableA = await newTable('Mesa A');
      const tableB = await newTable('Mesa B');
      const item = await newItem();
      const orderInB = await prisma.order.create({ data: { tableId: tableB.id, menuItemId: item.id, quantity: 1 } });

      await service.updateOrderQuantities(tenantId, tableA.id, [{ orderId: orderInB.id, quantity: 99 }]);

      const untouched = await prisma.order.findUnique({ where: { id: orderInB.id } });
      expect(untouched?.quantity).toBe(1);
    });

    it('no permite borrar una orden de otra mesa a través de este endpoint', async () => {
      const tableA = await newTable('Mesa A');
      const tableB = await newTable('Mesa B');
      const item = await newItem();
      const orderInB = await prisma.order.create({ data: { tableId: tableB.id, menuItemId: item.id, quantity: 1 } });

      await service.removeOrder(tenantId, tableA.id, [orderInB.id]);

      const stillThere = await prisma.order.findUnique({ where: { id: orderInB.id } });
      expect(stillThere).not.toBeNull();
    });
  });

  describe('resetTable', () => {
    it('vacía los pedidos y libera las mesas vinculadas', async () => {
      const parent = await newTable('Mesa Padre');
      const child = await newTable('Mesa Hija', { controlledById: parent.id, available: false });
      const item = await newItem();
      await prisma.order.create({ data: { tableId: parent.id, menuItemId: item.id, quantity: 1 } });

      const result = await service.resetTable(tenantId, parent.id);

      expect(result.table.orders).toHaveLength(0);
      expect(result.table.available).toBe(true);
      const updatedChild = await prisma.table.findUnique({ where: { id: child.id } });
      expect(updatedChild?.controlledById).toBeNull();
      expect(updatedChild?.available).toBe(true);
    });

    it('borra la hora de apertura: la próxima mesa empieza de cero', async () => {
      const table = await newTable('Mesa 1', { openedAt: new Date() });
      await service.resetTable(tenantId, table.id);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toBeNull();
    });
  });

  // Un negocio nunca puede ver ni tocar los datos de otro.
  describe('aislamiento entre negocios', () => {
    it('findAll devuelve solo las mesas del negocio', async () => {
      await newTable('Mía');
      await newTable('Ajena', {}, otherTenantId);

      const result = await service.findAll(tenantId);

      expect(result.map(t => t.name)).toEqual(['Mía']);
    });

    it('findOne de una mesa ajena tira 404', async () => {
      const foreign = await newTable('Ajena', {}, otherTenantId);

      await expect(service.findOne(tenantId, foreign.id)).rejects.toThrow(NotFoundException);
    });

    it('update, remove y resetTable de una mesa ajena tiran 404 y no la tocan', async () => {
      const foreign = await newTable('Ajena', {}, otherTenantId);

      await expect(service.update(tenantId, foreign.id, { name: 'Hackeada' })).rejects.toThrow(NotFoundException);
      await expect(service.remove(tenantId, foreign.id)).rejects.toThrow(NotFoundException);
      await expect(service.resetTable(tenantId, foreign.id)).rejects.toThrow(NotFoundException);

      const untouched = await prisma.table.findUnique({ where: { id: foreign.id } });
      expect(untouched?.name).toBe('Ajena');
    });

    it('addItems no acepta un ítem del menú de otro negocio', async () => {
      const table = await newTable('Mesa 1');
      const foreignItem = await newItem('Plato ajeno', otherTenantId);

      await expect(service.addItems(tenantId, table.id, [{ id: foreignItem.id, quantity: 1 }])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('assignWaiter no acepta un mozo de otro negocio', async () => {
      const table = await newTable('Mesa 1');
      const foreignWaiter = await prisma.waiter.create({ data: { name: 'Ajeno', tenantId: otherTenantId } });

      await expect(service.assignWaiter(tenantId, table.id, foreignWaiter.id, 'Ajeno')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('linkTables no acepta una mesa de otro negocio', async () => {
      const parent = await newTable('Mesa Padre');
      const foreign = await newTable('Ajena', {}, otherTenantId);

      await expect(service.linkTables(tenantId, parent.id, [foreign.id])).rejects.toThrow(NotFoundException);
    });
  });
});
