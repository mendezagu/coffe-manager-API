import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from '../sales/sales.service';
import { CashService } from './cash.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('CashService (caja)', () => {
  let prisma: PrismaService;
  let cash: CashService;
  let sales: SalesService;
  let tenantId: string;
  let otherTenantId: string;

  const caro: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };
  const juan: Actor = { id: 'c2', name: 'Juan', role: Role.CASHIER };
  const ana: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN }; // el admin ve la caja completa

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    cash = new CashService(prisma);
    sales = new SalesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', tipEnabled: true } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B' } })).id;
  });

  let n = 0;
  // Cobra una mesa de un plato de $price con los pagos indicados
  async function sell(price: number, input: { payments?: any[]; paymentMethod?: string; tip?: number; waiter?: string }, actor = caro, tid = tenantId) {
    const item = await prisma.menuItem.create({ data: { tenantId: tid, name: `Plato ${++n}`, price } });
    const waiter = await prisma.waiter.create({ data: { tenantId: tid, name: input.waiter ?? 'Mario' } });
    const table = await prisma.table.create({ data: { tenantId: tid, name: `Mesa ${n}`, available: false, waiterId: waiter.id } });
    await prisma.order.create({ data: { tableId: table.id, menuItemId: item.id, quantity: 1 } });
    return sales.checkout(tid, actor, table.id, { checkoutId: `checkout-${n}-${Math.random()}`, ...input });
  }

  it('al principio no hay caja abierta', async () => {
    const state = await cash.current(tenantId, Role.ADMIN);

    expect(state.open).toBe(false);
    expect(state.requireOpenRegister).toBe(true);
    expect(state.register).toBeNull();
  });

  it('abrir la caja registra quién, cuándo y con cuánto efectivo', async () => {
    const register = await cash.open(tenantId, ana, 20000);

    expect(register).toMatchObject({ open: true, openedByName: 'Ana', cash: { opening: 20000, expected: 20000 } });
    expect((await cash.current(tenantId, Role.ADMIN)).open).toBe(true);
  });

  it('hay una sola caja abierta por negocio (aunque abran a la vez)', async () => {
    await cash.open(tenantId, caro, 1000);

    await expect(cash.open(tenantId, juan, 500)).rejects.toThrow(ConflictException);
    expect(await prisma.cashRegister.count({ where: { tenantId } })).toBe(1); // no quedó una caja huérfana

    // dos aperturas simultáneas: solo una gana
    await cash.close(tenantId, caro, { countedAmount: 1000 });
    const results = await Promise.allSettled([cash.open(tenantId, caro, 0), cash.open(tenantId, juan, 0)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.cashRegister.count({ where: { tenantId, closedAt: null } })).toBe(1);
  });

  it('valida el efectivo inicial', async () => {
    await expect(cash.open(tenantId, caro, -5)).rejects.toThrow(BadRequestException);
    await expect(cash.open(tenantId, caro, NaN)).rejects.toThrow(BadRequestException);
    await expect(cash.open(tenantId, caro, 0)).resolves.toBeDefined(); // abrir en cero es válido
  });

  it('el efectivo esperado suma el fondo y los cobros en efectivo, y no cuenta tarjeta ni el vuelto', async () => {
    await cash.open(tenantId, caro, 20000);

    await sell(5000, { paymentMethod: 'efectivo' }); // +5000 efectivo
    await sell(3000, { paymentMethod: 'tarjeta' }); // tarjeta: no entra al cajón
    // $4000: $1000 tarjeta + $3000 efectivo (cliente da $5000, vuelto $2000): al cajón entran 3000
    await sell(4000, { payments: [{ method: 'tarjeta', amount: 1000 }, { method: 'efectivo', amount: 3000, tendered: 5000 }] });

    const state = await cash.current(tenantId, Role.ADMIN);
    expect(state.register?.cash).toMatchObject({ opening: 20000, sales: 8000, expected: 28000 });
    expect(state.register?.sales).toMatchObject({ count: 3, totalAmount: 12000 });
    expect(state.register?.byMethod).toEqual([
      { method: 'efectivo', amount: 8000, count: 2 },
      { method: 'tarjeta', amount: 4000, count: 2 },
    ]);
  });

  it('los movimientos manuales suman o restan al efectivo esperado', async () => {
    await cash.open(tenantId, caro, 10000);

    await cash.addMovement(tenantId, ana, { type: 'IN', amount: 2000, reason: 'Cambio que trajeron' });
    const state = await cash.addMovement(tenantId, ana, { type: 'OUT', amount: 3500, reason: 'Hielo' });

    expect(state.cash).toMatchObject({ in: 2000, out: 3500, expected: 8500 });
    expect(state.movements.map((m) => [m.type, m.amount, m.reason, m.createdBy])).toEqual([
      ['IN', 2000, 'Cambio que trajeron', 'Ana'],
      ['OUT', 3500, 'Hielo', 'Ana'],
    ]);
  });

  it('un movimiento necesita caja abierta, importe válido y motivo', async () => {
    await expect(cash.addMovement(tenantId, caro, { type: 'OUT', amount: 100, reason: 'x' })).rejects.toThrow(/No hay una caja abierta/);

    await cash.open(tenantId, caro, 0);
    await expect(cash.addMovement(tenantId, caro, { type: 'OUT', amount: 0, reason: 'x' })).rejects.toThrow(BadRequestException);
    await expect(cash.addMovement(tenantId, caro, { type: 'OUT', amount: -10, reason: 'x' })).rejects.toThrow(BadRequestException);
    await expect(cash.addMovement(tenantId, caro, { type: 'OUT', amount: 10, reason: '   ' })).rejects.toThrow(/motivo/);
  });

  it('cerrar calcula la diferencia entre lo contado y lo esperado (faltante y sobrante)', async () => {
    await cash.open(tenantId, caro, 10000);
    await sell(5000, { paymentMethod: 'efectivo' }); // esperado 15000

    const closed = await cash.close(tenantId, juan, { countedAmount: 14500, note: 'Faltaron $500' });

    expect(closed).toMatchObject({
      open: false,
      closedByName: 'Juan',
      countedAmount: 14500,
      difference: -500,
      note: 'Faltaron $500',
      cash: { expected: 15000 },
    });
    expect((await cash.current(tenantId, Role.ADMIN)).open).toBe(false);

    await cash.open(tenantId, caro, 0);
    expect((await cash.close(tenantId, caro, { countedAmount: 100 })).difference).toBe(100); // sobrante
  });

  it('una caja cerrada no cambia: su resumen queda fijo aunque entren datos nuevos', async () => {
    const register = await cash.open(tenantId, caro, 1000);
    await cash.close(tenantId, caro, { countedAmount: 1000 });

    await expect(cash.close(tenantId, caro, { countedAmount: 1 })).rejects.toThrow(/No hay una caja abierta/);
    await expect(cash.addMovement(tenantId, caro, { type: 'IN', amount: 50, reason: 'x' })).rejects.toThrow(ConflictException);

    expect((await cash.detail(tenantId, register.id)).cash.expected).toBe(1000);
  });

  it('muestra las propinas del turno por mozo', async () => {
    await cash.open(tenantId, caro, 0);
    await sell(1000, { paymentMethod: 'efectivo', tip: 100, waiter: 'Ana' });
    await sell(2000, { paymentMethod: 'tarjeta', tip: 200, waiter: 'Ana' });
    await sell(1000, { paymentMethod: 'efectivo', tip: 50, waiter: 'Beto' });

    const { register } = await cash.current(tenantId, Role.ADMIN);

    expect(register?.sales.tipsTotal).toBe(350);
    expect(register?.tipsByWaiter).toEqual([
      { waiterName: 'Ana', amount: 300 },
      { waiterName: 'Beto', amount: 50 },
    ]);
    // la propina en efectivo también entra al cajón (1100 + 1050); la de tarjeta no
    expect(register?.cash.sales).toBe(2150);
  });

  describe('conteo a ciegas', () => {
    // Turno con efectivo, tarjeta y un retiro: de ahí se podría deducir el efectivo esperado
    async function turnoConVentas() {
      await cash.open(tenantId, caro, 23500);
      await sell(54600, { paymentMethod: 'efectivo' });
      await sell(26200, { paymentMethod: 'tarjeta' });
      await cash.addMovement(tenantId, caro, { type: 'OUT', amount: 1000, reason: 'Hielo' });
    }

    it('mientras la caja está abierta, el cajero no recibe nada con lo que deducir el efectivo esperado', async () => {
      await turnoConVentas();

      const { register } = await cash.current(tenantId, Role.CASHIER);

      expect(register?.cash.expected).toBeNull();
      expect(register?.cash.sales).toBeNull(); // ni los cobros en efectivo
      expect(register?.byMethod).toEqual([]); // ni el desglose por método
      // lo que sí sabe: su fondo y sus movimientos
      expect(register?.cash).toMatchObject({ opening: 23500, in: 0, out: 1000 });
      // y ni siquiera el total vendido (con el fondo delataría el efectivo si casi todo fue en efectivo): solo cuántos cobros
      expect(register?.sales).toEqual({ count: 2, totalAmount: null, discountTotal: null, tipsTotal: null });
      expect(register?.tipsByWaiter).toEqual([]);
      // nada en el JSON entero que contenga el esperado (23500 + 54600 - 1000 = 77100), los cobros en efectivo ni el total vendido
      const raw = JSON.stringify(register);
      for (const secret of ['77100', '54600', '80800', '26200']) expect(raw).not.toContain(secret);
    });

    it('lo mismo vale para las respuestas de abrir caja y de registrar movimientos', async () => {
      const opened = await cash.open(tenantId, caro, 5000);
      expect(opened.cash.expected).toBeNull();

      const afterMovement = await cash.addMovement(tenantId, caro, { type: 'IN', amount: 100, reason: 'Cambio' });
      expect(afterMovement.cash.expected).toBeNull();
      expect(afterMovement.cash.sales).toBeNull();
    });

    it('el administrador sí ve la caja completa mientras está abierta', async () => {
      await turnoConVentas();

      const { register } = await cash.current(tenantId, Role.ADMIN);

      expect(register?.cash).toEqual({ opening: 23500, sales: 54600, in: 0, out: 1000, expected: 77100 });
      expect(register?.byMethod).toEqual([
        { method: 'efectivo', amount: 54600, count: 1 },
        { method: 'tarjeta', amount: 26200, count: 1 },
      ]);
    });

    it('al cerrar, el cajero recibe el resultado completo del arqueo', async () => {
      await turnoConVentas();

      const closed = await cash.close(tenantId, caro, { countedAmount: 77000 });

      expect(closed.cash).toEqual({ opening: 23500, sales: 54600, in: 0, out: 1000, expected: 77100 });
      expect(closed.difference).toBe(-100);
      // y ya cerrada, también la ve completa si la consulta después
      expect((await cash.detail(tenantId, closed.id)).cash.expected).toBe(77100);
    });

    it('copiar el total de ventas no sirve: da diferencia (las transferencias y tarjetas no entran al cajón)', async () => {
      await turnoConVentas();

      const closed = await cash.close(tenantId, caro, { countedAmount: 80800 }); // el total de ventas

      expect(closed.difference).toBe(3700); // sobran: el esperado era 77100
    });
  });

  it('el historial lista las cajas, la más reciente primero', async () => {
    await cash.open(tenantId, caro, 100);
    await cash.close(tenantId, caro, { countedAmount: 100 });
    await cash.open(tenantId, juan, 200);

    const history = await cash.history(tenantId);

    expect(history.map((r) => [r.openedByName, r.openingAmount, r.closedAt === null])).toEqual([
      ['Juan', 200, true],
      ['Caro', 100, false],
    ]);
  });

  describe('aislamiento entre negocios', () => {
    it('cada negocio tiene su propia caja', async () => {
      await cash.open(tenantId, caro, 100);

      expect((await cash.current(otherTenantId, Role.ADMIN)).open).toBe(false);
      await expect(cash.open(otherTenantId, juan, 50)).resolves.toBeDefined();
    });

    it('no se ven ni cierran cajas de otro negocio', async () => {
      const foreign = await cash.open(otherTenantId, juan, 50);

      await expect(cash.detail(tenantId, foreign.id)).rejects.toThrow(NotFoundException);
      expect(await cash.history(tenantId)).toEqual([]);
      await expect(cash.close(tenantId, caro, { countedAmount: 0 })).rejects.toThrow(/No hay una caja abierta/);
      expect((await cash.current(otherTenantId, Role.ADMIN)).open).toBe(true);
    });
  });
});
