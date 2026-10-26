import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { Actor, SalesService } from './sales.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Venta por mostrador', () => {
  let prisma: PrismaService;
  let sales: SalesService;
  let reports: ReportsService;
  let tenantId: string;
  let cafeId: string;
  let medialunaId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };
  const admin: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    sales = new SalesService(prisma);
    reports = new ReportsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  let n = 0;
  const id = () => `counter-${++n}-${Math.random().toString(36).slice(2)}`;

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', requireOpenRegister: false, tipEnabled: true } })).id;
    cafeId = (await prisma.menuItem.create({ data: { tenantId, name: 'Café', price: 2800 } })).id;
    medialunaId = (await prisma.menuItem.create({ data: { tenantId, name: 'Medialuna', price: 1500 } })).id;
  });

  it('cobra sin mesa: el servidor calcula el total y la venta queda como mostrador', async () => {
    const sale = await sales.counterCheckout(tenantId, cashier, {
      checkoutId: id(),
      items: [
        { menuItemId: cafeId, quantity: 2 },
        { menuItemId: medialunaId, quantity: 1 },
      ],
      takeaway: true,
      paymentMethod: 'qr',
    });

    expect(sale.totalAmount).toBe(7100);
    expect(sale.source).toBe('mostrador');
    expect(sale.takeaway).toBe(true);
    expect(sale.paymentMethod).toBe('qr');
    expect(sale.cashierName).toBe('Caro');
    expect(sale.items).toHaveLength(2);
  });

  it('el mismo producto tocado varias veces se suma', async () => {
    const sale = await sales.counterCheckout(tenantId, cashier, {
      checkoutId: id(),
      items: [
        { menuItemId: cafeId, quantity: 1 },
        { menuItemId: cafeId, quantity: 2 },
      ],
      paymentMethod: 'efectivo',
    });
    expect(sale.items).toHaveLength(1);
    expect(sale.items?.[0].quantity).toBe(3);
    expect(sale.totalAmount).toBe(8400);
  });

  it('un reintento del mismo cobro no duplica la venta', async () => {
    const checkoutId = id();
    const input = { checkoutId, items: [{ menuItemId: cafeId, quantity: 1 }], paymentMethod: 'efectivo' };
    const first = await sales.counterCheckout(tenantId, cashier, input);
    const second = await sales.counterCheckout(tenantId, cashier, input);
    expect(second._id).toBe(first._id);
    expect(await prisma.sale.count({ where: { tenantId } })).toBe(1);
  });

  it('exige elegir el método de pago', async () => {
    await expect(sales.counterCheckout(tenantId, cashier, { checkoutId: id(), items: [{ menuItemId: cafeId, quantity: 1 }] })).rejects.toThrow(
      'Elegí el método de pago',
    );
    expect(await prisma.sale.count({ where: { tenantId } })).toBe(0);
  });

  it('no cobra un pedido vacío ni productos de otro negocio', async () => {
    await expect(sales.counterCheckout(tenantId, cashier, { checkoutId: id(), items: [], paymentMethod: 'efectivo' })).rejects.toThrow(
      BadRequestException,
    );

    const other = (await prisma.tenant.create({ data: { name: 'B', requireOpenRegister: false } })).id;
    const foreign = await prisma.menuItem.create({ data: { tenantId: other, name: 'Ajeno', price: 100 } });
    await expect(
      sales.counterCheckout(tenantId, cashier, { checkoutId: id(), items: [{ menuItemId: foreign.id, quantity: 1 }], paymentMethod: 'efectivo' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('con propina, los pagos tienen que cubrir cuenta más propina y la propina no es venta', async () => {
    const sale = await sales.counterCheckout(tenantId, cashier, {
      checkoutId: id(),
      items: [{ menuItemId: cafeId, quantity: 1 }],
      tip: 200,
      payments: [{ method: 'efectivo', amount: 3000, tendered: 5000 }],
    });
    expect(sale.totalAmount).toBe(2800);
    expect(sale.tipAmount).toBe(200);
    expect(sale.payments?.[0].change).toBe(2000);

    await expect(
      sales.counterCheckout(tenantId, cashier, {
        checkoutId: id(),
        items: [{ menuItemId: cafeId, quantity: 1 }],
        payments: [{ method: 'efectivo', amount: 1000 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('el cajero solo da descuento si el negocio lo habilitó; el administrador siempre', async () => {
    const input = { items: [{ menuItemId: cafeId, quantity: 1 }], paymentMethod: 'efectivo', globalDiscount: 10 };
    await expect(sales.counterCheckout(tenantId, cashier, { checkoutId: id(), ...input })).rejects.toThrow(ForbiddenException);

    const withDiscount = await sales.counterCheckout(tenantId, admin, { checkoutId: id(), ...input });
    expect(withDiscount.totalAmount).toBe(2520);
  });

  it('con la caja cerrada y exigida, no cobra', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { requireOpenRegister: true } });
    await expect(
      sales.counterCheckout(tenantId, cashier, { checkoutId: id(), items: [{ menuItemId: cafeId, quantity: 1 }], paymentMethod: 'efectivo' }),
    ).rejects.toThrow(ConflictException);
  });

  it('en los reportes suma al total pero no cuenta como mesa ni como mozo', async () => {
    const waiter = await prisma.waiter.create({ data: { tenantId, name: 'Mario' } });
    const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 1', available: false, waiterId: waiter.id } });
    await prisma.order.create({ data: { tableId: table.id, menuItemId: cafeId, quantity: 1 } });
    await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' });
    await sales.counterCheckout(tenantId, cashier, { checkoutId: id(), items: [{ menuItemId: medialunaId, quantity: 2 }], paymentMethod: 'qr' });

    const all = await reports.sales(tenantId, { tz: 'UTC' });
    expect(all.summary.totalAmount).toBe(5800);
    expect(all.bySource.mesa).toEqual({ salesCount: 1, totalAmount: 2800 });
    expect(all.bySource.mostrador).toEqual({ salesCount: 1, totalAmount: 3000 });
    expect(all.byTable.map((t: any) => t.name)).toEqual(['Mesa 1']);
    expect(all.byWaiter.map((w: any) => w.name)).toEqual(['Mario']);
    expect(all.byHour.reduce((s, h) => s + h.salesCount, 0)).toBe(2);

    const onlyCounter = await reports.sales(tenantId, { tz: 'UTC', source: 'mostrador' });
    expect(onlyCounter.summary.totalAmount).toBe(3000);
  });
});
