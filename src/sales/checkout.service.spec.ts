import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { CashService } from '../cash/cash.service';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from './sales.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Cobro: pagos mixtos, propinas, cobro por partes y caja', () => {
  let prisma: PrismaService;
  let sales: SalesService;
  let cash: CashService;
  let tenantId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };
  const admin: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    sales = new SalesService(prisma);
    cash = new CashService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup(tenant: { requireOpenRegister?: boolean; tipEnabled?: boolean; commissionEnabled?: boolean; commissionPct?: number } = {}) {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', requireOpenRegister: false, ...tenant } })).id;
  }

  // Mesa con café x3 ($1000 c/u) y torta x1 ($2500) = $5500
  async function tableSetup() {
    const cafe = await prisma.menuItem.create({ data: { tenantId, name: 'Café', price: 1000 } });
    const torta = await prisma.menuItem.create({ data: { tenantId, name: 'Torta', price: 2500 } });
    const waiter = await prisma.waiter.create({ data: { tenantId, name: 'Mario' } });
    const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 1', available: false, waiterId: waiter.id } });
    const cafeOrder = await prisma.order.create({ data: { tableId: table.id, menuItemId: cafe.id, quantity: 3 } });
    const tortaOrder = await prisma.order.create({ data: { tableId: table.id, menuItemId: torta.id, quantity: 1 } });
    return { table, cafeOrder, tortaOrder };
  }

  let n = 0;
  const id = () => `checkout-${++n}-${Math.random().toString(36).slice(2)}`;

  describe('pagos mixtos y vuelto', () => {
    beforeEach(() => setup());

    it('un cobro con varios métodos guarda cada pago y calcula el vuelto en efectivo', async () => {
      const { table } = await tableSetup(); // $5500

      const sale = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        payments: [
          { method: 'tarjeta', amount: 2000 },
          { method: 'efectivo', amount: 3500, tendered: 4000 },
        ],
      });

      expect(sale.paymentMethod).toBe('mixto');
      expect(sale.totalAmount).toBe(5500);
      expect(sale.payments).toEqual([
        { method: 'tarjeta', amount: 2000, tendered: null, change: 0 },
        { method: 'efectivo', amount: 3500, tendered: 4000, change: 500 },
      ]);
    });

    it('los pagos tienen que sumar exactamente la cuenta: si no, no se cobra nada', async () => {
      const { table } = await tableSetup();

      await expect(
        sales.checkout(tenantId, cashier, table.id, {
          checkoutId: id(),
          payments: [{ method: 'tarjeta', amount: 2000 }, { method: 'efectivo', amount: 3000 }],
        }),
      ).rejects.toThrow(/Los pagos suman/);
      await expect(
        sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), payments: [{ method: 'tarjeta', amount: 6000 }] }),
      ).rejects.toThrow(BadRequestException);

      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(2);
    });

    it('rechaza efectivo recibido menor al importe, métodos repetidos y métodos inválidos', async () => {
      const { table } = await tableSetup();
      const pay = (payments: any[]) => sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), payments });

      await expect(pay([{ method: 'efectivo', amount: 5500, tendered: 5000 }])).rejects.toThrow(/efectivo recibido/);
      await expect(pay([{ method: 'tarjeta', amount: 2500 }, { method: 'tarjeta', amount: 3000 }])).rejects.toThrow(/repetido/);
      await expect(pay([{ method: 'bitcoin', amount: 5500 }])).rejects.toThrow(BadRequestException);
    });

    it('"recibido" solo vale para efectivo; en otros métodos se ignora', async () => {
      const { table } = await tableSetup();

      const sale = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        payments: [{ method: 'tarjeta', amount: 5500, tendered: 9999 }],
      });

      expect(sale.payments?.[0]).toEqual({ method: 'tarjeta', amount: 5500, tendered: null, change: 0 });
    });

    it('el atajo de un solo método sigue funcionando y crea un pago por el total', async () => {
      const { table } = await tableSetup();

      const sale = await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'qr' });

      expect(sale.paymentMethod).toBe('qr');
      expect(sale.payments).toEqual([{ method: 'qr', amount: 5500, tendered: null, change: 0 }]);
    });

    it('sin método ni pagos no se cobra', async () => {
      const { table } = await tableSetup();

      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id() })).rejects.toThrow('Elegí el método de pago');
    });

    it('un pago con método vacío tampoco se acepta', async () => {
      const { table } = await tableSetup();

      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), payments: [{ method: '', amount: 5500 }] })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('comisión de mozos', () => {
    it('con la comisión activa, la venta guarda el porcentaje vigente (y no cambia si después se ajusta)', async () => {
      await setup({ commissionEnabled: true, commissionPct: 8 });
      const { table, cafeOrder } = await tableSetup(); // $5500

      const pctOf = async (checkoutId: string) =>
        (await prisma.sale.findFirstOrThrow({ where: { tenantId, checkoutId } })).commissionPct;

      // cobro parcial: solo el café (3 × $1000)
      const firstId = id();
      await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: firstId,
        paymentMethod: 'efectivo',
        lines: [{ orderId: cafeOrder.id, quantity: 3 }],
      } as any);
      expect(await pctOf(firstId)).toBe(8);

      await prisma.tenant.update({ where: { id: tenantId }, data: { commissionPct: 12 } });
      const secondId = id();
      await sales.checkout(tenantId, cashier, table.id, { checkoutId: secondId, paymentMethod: 'efectivo' });
      expect(await pctOf(secondId)).toBe(12);

      // la primera venta conserva el 8 %
      expect(await pctOf(firstId)).toBe(8);
    });

    it('con la comisión apagada, la venta no lleva comisión aunque haya quedado un porcentaje guardado', async () => {
      await setup({ commissionEnabled: false, commissionPct: 8 });
      const { table } = await tableSetup();
      const checkoutId = id();
      await sales.checkout(tenantId, cashier, table.id, { checkoutId, paymentMethod: 'efectivo' });
      const stored = await prisma.sale.findFirstOrThrow({ where: { tenantId, checkoutId } });
      expect(stored.commissionPct).toBe(0);
    });
  });

  describe('propinas', () => {
    it('la propina se cobra con la cuenta pero no es venta', async () => {
      await setup({ tipEnabled: true });
      const { table } = await tableSetup(); // $5500

      const sale = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        tip: 550,
        payments: [{ method: 'tarjeta', amount: 6050 }],
      });

      expect(sale.totalAmount).toBe(5500); // la facturación no incluye la propina
      expect(sale.tipAmount).toBe(550);
      expect(sale.payments?.[0].amount).toBe(6050); // pero se pagó junto
    });

    it('con propina, los pagos tienen que sumar cuenta + propina', async () => {
      await setup({ tipEnabled: true });
      const { table } = await tableSetup();

      await expect(
        sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), tip: 550, payments: [{ method: 'tarjeta', amount: 5500 }] }),
      ).rejects.toThrow(/Los pagos suman/);
    });

    it('el atajo de un método cobra cuenta + propina', async () => {
      await setup({ tipEnabled: true });
      const { table } = await tableSetup();

      const sale = await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), tip: 500, paymentMethod: 'efectivo' });

      expect(sale.payments?.[0].amount).toBe(6000);
    });

    it('si el negocio no activó las propinas, se rechazan', async () => {
      await setup({ tipEnabled: false });
      const { table } = await tableSetup();

      await expect(
        sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), tip: 100, paymentMethod: 'efectivo' }),
      ).rejects.toThrow(/propinas no están activadas/);
    });

    it('rechaza propinas negativas o absurdamente altas', async () => {
      await setup({ tipEnabled: true });
      const { table } = await tableSetup();

      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), tip: -50, paymentMethod: 'efectivo' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), tip: 999999, paymentMethod: 'efectivo' })).rejects.toThrow(
        /demasiado alta/,
      );
    });
  });

  describe('cobro por partes (división por platos)', () => {
    beforeEach(() => setup());

    it('cobra solo lo elegido, descuenta de la mesa y la deja ocupada con el resto', async () => {
      const { table, cafeOrder } = await tableSetup();

      const sale = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [{ orderId: cafeOrder.id, quantity: 2 }], // 2 de los 3 cafés
      });

      expect(sale.totalAmount).toBe(2000);
      expect(sale.items).toHaveLength(1);
      expect(sale.items?.[0]).toMatchObject({ name: 'Café', quantity: 2 });

      const after = await prisma.table.findUnique({ where: { id: table.id }, include: { orders: true } });
      expect(after?.available).toBe(false); // sigue ocupada
      expect(after?.waiterId).not.toBeNull(); // y con su mozo
      expect(after?.orders.find((o) => o.id === cafeOrder.id)?.quantity).toBe(1);
      expect(after?.orders).toHaveLength(2);
    });

    it('la mesa se libera recién cuando se cobró todo, y las partes suman la cuenta completa', async () => {
      const { table, cafeOrder, tortaOrder } = await tableSetup();

      const first = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(), paymentMethod: 'efectivo', lines: [{ orderId: cafeOrder.id, quantity: 3 }],
      });
      expect((await prisma.table.findUnique({ where: { id: table.id } }))?.available).toBe(false);

      const second = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(), paymentMethod: 'tarjeta', lines: [{ orderId: tortaOrder.id, quantity: 1 }],
      });

      const after = await prisma.table.findUnique({ where: { id: table.id }, include: { orders: true } });
      expect(after?.available).toBe(true);
      expect(after?.waiterId).toBeNull();
      expect(after?.orders).toHaveLength(0);
      expect(first.totalAmount + second.totalAmount).toBe(5500);
    });

    it('cobrar sin indicar líneas sigue cobrando y liberando toda la mesa', async () => {
      const { table } = await tableSetup();

      await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' });

      expect((await prisma.table.findUnique({ where: { id: table.id } }))?.available).toBe(true);
    });

    it('valida las líneas: cantidad válida, que existan y que no se repitan', async () => {
      const { table, cafeOrder } = await tableSetup();
      const charge = (lines: any[]) => sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo', lines });

      await expect(charge([{ orderId: cafeOrder.id, quantity: 4 }])).rejects.toThrow(/cantidad/);
      await expect(charge([{ orderId: cafeOrder.id, quantity: 0 }])).rejects.toThrow(BadRequestException);
      await expect(charge([{ orderId: 'no-existe', quantity: 1 }])).rejects.toThrow(BadRequestException);
      await expect(charge([{ orderId: cafeOrder.id, quantity: 1 }, { orderId: cafeOrder.id, quantity: 1 }])).rejects.toThrow(/repetido/);
      expect(await prisma.sale.count()).toBe(0);
    });

    it('los descuentos del admin aplican solo a las líneas que se cobran', async () => {
      const { table, cafeOrder, tortaOrder } = await tableSetup();

      const sale = await sales.checkout(tenantId, admin, table.id, {
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [{ orderId: cafeOrder.id, quantity: 1 }],
        items: [{ orderId: cafeOrder.id, discount: 50 }],
      });
      expect(sale.totalAmount).toBe(500);

      await expect(
        sales.checkout(tenantId, admin, table.id, {
          checkoutId: id(),
          paymentMethod: 'efectivo',
          lines: [{ orderId: cafeOrder.id, quantity: 1 }],
          items: [{ orderId: tortaOrder.id, discount: 10 }], // la torta no se está cobrando
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('el cajero solo puede dar descuentos si el negocio lo habilitó; el mozo nunca', async () => {
      const { table, cafeOrder } = await tableSetup();
      const withDiscount = () => ({
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [{ orderId: cafeOrder.id, quantity: 1 }],
        globalDiscount: 10,
      });

      // apagado (por defecto): el cajero no puede
      await expect(sales.checkout(tenantId, cashier, table.id, withDiscount())).rejects.toThrow(/no habilitó/);

      // encendido: el cajero puede
      await prisma.tenant.update({ where: { id: tenantId }, data: { cashierDiscounts: true } });
      const sale = await sales.checkout(tenantId, cashier, table.id, withDiscount());
      expect(sale.totalAmount).toBe(900);

      // el mozo no cobra con descuento aunque esté encendido
      const waiterActor: Actor = { id: 'w1', name: 'Walter', role: Role.WAITER };
      await expect(sales.checkout(tenantId, waiterActor, table.id, withDiscount())).rejects.toThrow(ForbiddenException);
    });

    it('la permanencia cuenta desde que se abrió la mesa, aunque un cobro parcial borre los primeros pedidos', async () => {
      const { table, cafeOrder, tortaOrder } = await tableSetup();
      const opened = new Date(Date.now() - 90 * 60000); // se abrió hace 90 minutos
      await prisma.table.update({ where: { id: table.id }, data: { openedAt: opened } });

      // cobro parcial: se paga todo el café y se borra esa línea (la más vieja)
      const partial = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [{ orderId: cafeOrder.id, quantity: 3 }],
      });
      expect((await prisma.sale.findUniqueOrThrow({ where: { id: partial._id } })).tableOpenedAt).toBeNull();
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toEqual(opened);

      // cobro final: la mesa se libera y la venta recuerda la apertura original
      const last = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [{ orderId: tortaOrder.id, quantity: 1 }],
      });
      const stored = await prisma.sale.findUniqueOrThrow({ where: { id: last._id } });
      expect(stored.tableOpenedAt).toEqual(opened);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table.id } })).openedAt).toBeNull();
    });

    it('una mesa abierta antes de registrar la apertura usa la orden más vieja', async () => {
      const { table, cafeOrder, tortaOrder } = await tableSetup(); // sin openedAt
      const oldest = (await prisma.order.findMany({ where: { tableId: table.id }, orderBy: { createdAt: 'asc' } }))[0].createdAt;
      const sale = await sales.checkout(tenantId, cashier, table.id, {
        checkoutId: id(),
        paymentMethod: 'efectivo',
        lines: [
          { orderId: cafeOrder.id, quantity: 3 },
          { orderId: tortaOrder.id, quantity: 1 },
        ],
      });
      expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale._id } })).tableOpenedAt).toEqual(oldest);
    });

    it('los cobros parciales son idempotentes: repetir el mismo no descuenta dos veces', async () => {
      const { table, cafeOrder } = await tableSetup();
      const checkoutId = id();
      const input = { checkoutId, paymentMethod: 'efectivo', lines: [{ orderId: cafeOrder.id, quantity: 1 }] };

      const a = await sales.checkout(tenantId, cashier, table.id, input);
      const b = await sales.checkout(tenantId, cashier, table.id, input);

      expect(b._id).toBe(a._id);
      expect((await prisma.order.findUnique({ where: { id: cafeOrder.id } }))?.quantity).toBe(2);
    });
  });

  describe('exigir caja abierta', () => {
    beforeEach(() => setup({ requireOpenRegister: true }));

    it('sin caja abierta no se cobra, y la mesa queda intacta', async () => {
      const { table } = await tableSetup();

      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' })).rejects.toThrow(
        /No hay caja abierta/,
      );

      expect(await prisma.sale.count()).toBe(0);
      expect(await prisma.order.count({ where: { tableId: table.id } })).toBe(2);
    });

    it('con caja abierta, la venta queda asociada a esa caja', async () => {
      const { table } = await tableSetup();
      const register = await cash.open(tenantId, cashier, 20000);

      const sale = await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' });

      expect(sale.registerId).toBe(register.id);
    });

    it('al cerrar la caja se vuelve a bloquear el cobro', async () => {
      const { table } = await tableSetup();
      await cash.open(tenantId, cashier, 0);
      await cash.close(tenantId, cashier, { countedAmount: 0 });

      await expect(sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('si el negocio no exige caja, se cobra igual (sin caja asociada)', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { requireOpenRegister: false } });
      const { table } = await tableSetup();

      const sale = await sales.checkout(tenantId, cashier, table.id, { checkoutId: id(), paymentMethod: 'efectivo' });

      expect(sale.registerId).toBeNull();
    });
  });
});
