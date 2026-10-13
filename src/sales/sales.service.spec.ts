import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from './sales.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('SalesService', () => {
  let prisma: PrismaService;
  let service: SalesService;
  let tenantId: string;
  let otherTenantId: string;

  const admin: Actor = { id: 'admin-1', name: 'Ana Admin', role: Role.ADMIN };
  const cashier: Actor = { id: 'cashier-1', name: 'Caro Cajera', role: Role.CASHIER };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new SalesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({}); // arrastra todo lo del negocio (onDelete: Cascade)
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Negocio B', requireOpenRegister: false } })).id;
  });

  const item = (name: string, price: number, extra: object = {}, tid = tenantId) =>
    prisma.menuItem.create({ data: { name, price, tenantId: tid, ...extra } });

  // Mesa con mozo y las órdenes indicadas: [plato, cantidad, nota?]
  async function tableWith(orders: [{ id: string }, number, string?][], tid = tenantId) {
    const waiter = await prisma.waiter.create({ data: { name: 'Mario Mozo', tenantId: tid } });
    const table = await prisma.table.create({
      data: { name: 'Mesa 1', tenantId: tid, available: false, waiterId: waiter.id },
    });
    const created = [];
    for (const [menuItem, quantity, note] of orders) {
      created.push(
        await prisma.order.create({ data: { tableId: table.id, menuItemId: menuItem.id, quantity, note: note ?? '' } }),
      );
    }
    return { table, orders: created };
  }

  const checkoutId = () => `co-${Math.random().toString(36).slice(2)}-${Date.now()}`;

  describe('checkout', () => {
    it('calcula el total en el servidor, guarda el detalle y libera la mesa', async () => {
      const cafe = await item('Café', 1000);
      const torta = await item('Torta', 2500);
      const { table } = await tableWith([[cafe, 2], [torta, 1, 'sin crema']]);

      const sale = await service.checkout(tenantId, cashier, table.id, {
        checkoutId: checkoutId(),
        paymentMethod: 'efectivo',
      });

      expect(sale.totalAmount).toBe(4500); // 2 x 1000 + 2500
      expect(sale.grossTotal).toBe(4500);
      expect(sale.discountTotal).toBe(0);
      expect(sale.waiterName).toBe('Mario Mozo');
      expect(sale.cashierName).toBe('Caro Cajera');
      expect(sale.items).toHaveLength(2);
      expect(sale.items?.find((i) => i.name === 'Torta')).toMatchObject({ unitPrice: 2500, quantity: 1, note: 'sin crema' });

      // la mesa quedó libre y sin órdenes
      const after = await prisma.table.findUnique({ where: { id: table.id }, include: { orders: true } });
      expect(after?.available).toBe(true);
      expect(after?.waiterId).toBeNull();
      expect(after?.orders).toHaveLength(0);
    });

    it('guarda el precio de ese momento: cambiar el menú después no altera la venta', async () => {
      const cafe = await item('Café', 1000);
      const { table } = await tableWith([[cafe, 1]]);
      const sale = await service.checkout(tenantId, cashier, table.id, { checkoutId: checkoutId(), paymentMethod: 'qr' });

      await prisma.menuItem.update({ where: { id: cafe.id }, data: { price: 9999 } });

      const stored = await service.findOne(tenantId, sale._id);
      expect(stored.items?.[0].unitPrice).toBe(1000);
      expect(stored.totalAmount).toBe(1000);
    });

    it('es idempotente: repetir el mismo cobro devuelve la misma venta y no duplica nada', async () => {
      const cafe = await item('Café', 1000);
      const { table } = await tableWith([[cafe, 1]]);
      const id = checkoutId();

      const first = await service.checkout(tenantId, cashier, table.id, { checkoutId: id, paymentMethod: 'efectivo' });
      const second = await service.checkout(tenantId, cashier, table.id, { checkoutId: id, paymentMethod: 'efectivo' });

      expect(second._id).toBe(first._id);
      expect(await prisma.sale.count({ where: { tenantId } })).toBe(1);
    });

    it('dos cobros simultáneos del mismo checkoutId dejan una sola venta', async () => {
      const cafe = await item('Café', 1000);
      const { table } = await tableWith([[cafe, 1]]);
      const id = checkoutId();

      const results = await Promise.allSettled([
        service.checkout(tenantId, cashier, table.id, { checkoutId: id, paymentMethod: 'efectivo' }),
        service.checkout(tenantId, cashier, table.id, { checkoutId: id, paymentMethod: 'efectivo' }),
      ]);

      expect(await prisma.sale.count({ where: { tenantId } })).toBe(1);
      // ninguno de los dos debe dar error al usuario
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('el admin aplica descuentos: por ítem y general (sin tocar promos)', async () => {
      const cafe = await item('Café', 1000);
      const promo = await item('Combo', 2000, { isPromo: true });
      const { table, orders } = await tableWith([[cafe, 2], [promo, 1]]);

      const sale = await service.checkout(tenantId, admin, table.id, {
        checkoutId: checkoutId(),
        paymentMethod: 'tarjeta',
        globalDiscount: 10,
        items: [
          { orderId: orders[0].id, discount: 50 }, // café: 2000 -> 1000
          { orderId: orders[1].id, discount: 90 }, // promo: el descuento se ignora
        ],
      });

      // café 1000 (con 50%) + promo 2000 = 3000; 10% general solo sobre el café (100)
      expect(sale.grossTotal).toBe(4000);
      expect(sale.totalAmount).toBe(2900);
      expect(sale.discountTotal).toBe(1100);
      expect(sale.items?.find((i) => i.name === 'Combo')?.discountPct).toBe(0);
    });

    it('un cajero no puede aplicar descuentos', async () => {
      const cafe = await item('Café', 1000);
      const { table, orders } = await tableWith([[cafe, 1]]);

      await expect(
        service.checkout(tenantId, cashier, table.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo', globalDiscount: 10 }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.checkout(tenantId, cashier, table.id, {
          checkoutId: checkoutId(),
          paymentMethod: 'efectivo',
          items: [{ orderId: orders[0].id, discount: 5 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      // y no se cobró nada: la mesa sigue ocupada con su orden
      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(1);
    });

    it('rechaza método de pago inválido, mesa vacía y descuentos para órdenes ajenas', async () => {
      const cafe = await item('Café', 1000);
      const { table } = await tableWith([[cafe, 1]]);
      const empty = await prisma.table.create({ data: { name: 'Vacía', tenantId } });

      await expect(
        service.checkout(tenantId, cashier, table.id, { checkoutId: checkoutId(), paymentMethod: 'bitcoin' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.checkout(tenantId, cashier, empty.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.checkout(tenantId, admin, table.id, {
          checkoutId: checkoutId(),
          paymentMethod: 'efectivo',
          items: [{ orderId: 'no-existe', discount: 10 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('no cobra una mesa vinculada a otra', async () => {
      const cafe = await item('Café', 1000);
      const { table: parent } = await tableWith([[cafe, 1]]);
      const child = await prisma.table.create({ data: { name: 'Hija', tenantId, controlledById: parent.id } });

      await expect(
        service.checkout(tenantId, cashier, child.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('al cobrar la mesa principal libera las mesas vinculadas', async () => {
      const cafe = await item('Café', 1000);
      const { table: parent } = await tableWith([[cafe, 1]]);
      const child = await prisma.table.create({
        data: { name: 'Hija', tenantId, controlledById: parent.id, available: false },
      });

      await service.checkout(tenantId, cashier, parent.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' });

      const after = await prisma.table.findUnique({ where: { id: child.id } });
      expect(after?.controlledById).toBeNull();
      expect(after?.available).toBe(true);
    });

    it('si una orden es de un plato borrado del menú, no cobra y avisa', async () => {
      const cafe = await item('Café', 1000);
      const { table } = await tableWith([[cafe, 1]]);
      await prisma.menuItem.delete({ where: { id: cafe.id } }); // la FK deja la orden con menuItemId null

      await expect(
        service.checkout(tenantId, cashier, table.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' }),
      ).rejects.toThrow(ConflictException);
      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(1);
    });
  });

  describe('aislamiento entre negocios', () => {
    it('no se puede cobrar una mesa de otro negocio', async () => {
      const foreignItem = await item('Ajeno', 500, {}, otherTenantId);
      const { table } = await tableWith([[foreignItem, 1]], otherTenantId);

      await expect(
        service.checkout(tenantId, cashier, table.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' }),
      ).rejects.toThrow(NotFoundException);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(1);
    });

    it('el mismo checkoutId en dos negocios no se mezcla', async () => {
      const a = await item('Café', 1000);
      const b = await item('Café', 2000, {}, otherTenantId);
      const { table: tableA } = await tableWith([[a, 1]]);
      const { table: tableB } = await tableWith([[b, 1]], otherTenantId);
      const id = checkoutId();

      const saleA = await service.checkout(tenantId, cashier, tableA.id, { checkoutId: id, paymentMethod: 'efectivo' });
      const saleB = await service.checkout(otherTenantId, cashier, tableB.id, { checkoutId: id, paymentMethod: 'efectivo' });

      expect(saleA.totalAmount).toBe(1000);
      expect(saleB.totalAmount).toBe(2000);
    });

    it('findAll, findOne y removeAll solo ven y borran las ventas del propio negocio', async () => {
      const a = await item('Café', 1000);
      const b = await item('Café', 2000, {}, otherTenantId);
      const { table: tableA } = await tableWith([[a, 1]]);
      const { table: tableB } = await tableWith([[b, 1]], otherTenantId);
      await service.checkout(tenantId, cashier, tableA.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' });
      const foreign = await service.checkout(otherTenantId, cashier, tableB.id, { checkoutId: checkoutId(), paymentMethod: 'efectivo' });

      expect(await service.findAll(tenantId)).toHaveLength(1);
      await expect(service.findOne(tenantId, foreign._id)).rejects.toThrow(NotFoundException);

      await service.removeAll(tenantId);
      expect(await prisma.sale.count({ where: { tenantId } })).toBe(0);
      expect(await prisma.sale.count({ where: { tenantId: otherTenantId } })).toBe(1);
    });
  });
});
