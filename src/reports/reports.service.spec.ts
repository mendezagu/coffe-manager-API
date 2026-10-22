import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';
import { addDays, daysBetween, localDay, startOfDay } from './zoned-date';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

const BA = 'America/Argentina/Buenos_Aires'; // UTC-3 todo el año

describe('zoned-date', () => {
  it('startOfDay respeta la zona: el día local de Buenos Aires empieza a las 03:00 UTC', () => {
    expect(startOfDay('2026-10-10', BA).toISOString()).toBe('2026-10-10T03:00:00.000Z');
    expect(startOfDay('2026-10-10', 'UTC').toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('localDay: una venta a las 23:30 locales todavía es del día anterior en UTC+0', () => {
    const instant = new Date('2026-10-10T02:30:00.000Z'); // 23:30 del 9 en Buenos Aires
    expect(localDay(instant, BA)).toBe('2026-10-09');
    expect(localDay(instant, 'UTC')).toBe('2026-10-10');
  });

  it('addDays y daysBetween cruzan meses y años', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(4);
  });
});

describe('ReportsService', () => {
  let prisma: PrismaService;
  let service: ReportsService;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new ReportsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A' } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Negocio B' } })).id;
  });

  let n = 0;
  async function sale(
    date: string,
    opts: {
      total: number;
      waiter?: string;
      payment?: string;
      globalPct?: number;
      tip?: number;
      commissionPct?: number;
      payments?: { method: string; amount: number }[];
      items?: { name: string; unitPrice: number; quantity: number; lineTotal: number; isPromo?: boolean }[];
      tenant?: string;
    },
  ) {
    return prisma.sale.create({
      data: {
        tenantId: opts.tenant ?? tenantId,
        checkoutId: `co-${++n}-${Math.random()}`,
        tableName: 'Mesa 1',
        waiterName: opts.waiter ?? 'Mario',
        paymentMethod: opts.payment ?? 'efectivo',
        grossTotal: opts.total,
        totalAmount: opts.total,
        globalDiscountPct: opts.globalPct ?? 0,
        tipAmount: opts.tip ?? 0,
        commissionPct: opts.commissionPct ?? 0,
        payments: { create: opts.payments ?? [] },
        date: new Date(date),
        items: { create: opts.items ?? [] },
      },
    });
  }

  const cafe = (quantity: number, price = 1000) => ({ name: 'Café', unitPrice: price, quantity, lineTotal: price * quantity });
  const torta = (quantity: number) => ({ name: 'Torta', unitPrice: 2500, quantity, lineTotal: 2500 * quantity });

  it('suma ventas, ticket promedio y descuentos del rango', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 3000, items: [cafe(3)] });
    await sale('2026-10-11T15:00:00Z', { total: 5000, items: [torta(2)] });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-11', tz: BA });

    expect(r.summary).toMatchObject({ salesCount: 2, totalAmount: 8000, averageTicket: 4000, itemsSold: 5, salesWithoutDetail: 0 });
  });

  it('agrupa por día de la zona horaria del negocio y rellena los días sin ventas', async () => {
    // 23:30 del 9 en Buenos Aires = 02:30 del 10 en UTC
    await sale('2026-10-10T02:30:00Z', { total: 1000, items: [cafe(1)] });
    await sale('2026-10-11T15:00:00Z', { total: 2000, items: [cafe(2)] });

    const r = await service.sales(tenantId, { from: '2026-10-09', to: '2026-10-12', tz: BA });

    expect(r.byDay).toEqual([
      { date: '2026-10-09', salesCount: 1, totalAmount: 1000 },
      { date: '2026-10-10', salesCount: 0, totalAmount: 0 },
      { date: '2026-10-11', salesCount: 1, totalAmount: 2000 },
      { date: '2026-10-12', salesCount: 0, totalAmount: 0 },
    ]);
  });

  it('incluye los extremos del rango y deja afuera lo que cae fuera', async () => {
    await sale('2026-10-09T02:59:59Z', { total: 100 }); // 23:59:59 del 8 en BA: antes del rango
    await sale('2026-10-09T03:00:00Z', { total: 200 }); // 00:00:00 del 9: entra
    await sale('2026-10-11T02:59:59Z', { total: 300 }); // 23:59:59 del 10: entra
    await sale('2026-10-11T03:00:00Z', { total: 400 }); // 00:00 del 11: afuera

    const r = await service.sales(tenantId, { from: '2026-10-09', to: '2026-10-10', tz: BA });

    expect(r.summary.totalAmount).toBe(500);
  });

  it('ranking de platos: junta por nombre, suma cantidad e importe y reparte el descuento general', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 3000, items: [cafe(2, 1000), torta(1)] });
    // 10% general: aplica a lo que no es promo; la promo queda igual
    await sale('2026-10-10T16:00:00Z', {
      total: 2700,
      globalPct: 10,
      items: [cafe(3, 1000), { name: 'Combo', unitPrice: 0, quantity: 1, lineTotal: 0, isPromo: true }],
    });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
    expect(byName['Café']).toEqual({ name: 'Café', quantity: 5, amount: 2000 + 2700, cost: null, profit: null }); // 2000 + 3000*0,9
    expect(byName['Torta']).toEqual({ name: 'Torta', quantity: 1, amount: 2500, cost: null, profit: null });
    expect(r.items[0].name).toBe('Café'); // ordenado por importe
  });

  it('agrupa por mozo y por método de pago, de mayor a menor', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 1000, waiter: 'Ana', payment: 'tarjeta' });
    await sale('2026-10-10T16:00:00Z', { total: 4000, waiter: 'Beto', payment: 'efectivo' });
    await sale('2026-10-10T17:00:00Z', { total: 500, waiter: 'Ana', payment: 'efectivo' });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.byWaiter).toEqual([
      { name: 'Beto', salesCount: 1, totalAmount: 4000, tips: 0, commission: 0 },
      { name: 'Ana', salesCount: 2, totalAmount: 1500, tips: 0, commission: 0 },
    ]);
    expect(r.byPayment).toEqual([
      { method: 'efectivo', salesCount: 2, totalAmount: 4500 },
      { method: 'tarjeta', salesCount: 1, totalAmount: 1000 },
    ]);
  });

  it('por método de pago cuenta lo que entró con cada uno: un cobro mixto suma en varios', async () => {
    await sale('2026-10-10T15:00:00Z', {
      total: 5000,
      payments: [{ method: 'tarjeta', amount: 2000 }, { method: 'efectivo', amount: 3000 }],
    });
    await sale('2026-10-10T16:00:00Z', { total: 1000, payments: [{ method: 'efectivo', amount: 1000 }] });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.summary.totalAmount).toBe(6000); // la venta es una sola, aunque se pague en dos métodos
    expect(r.byPayment).toEqual([
      { method: 'efectivo', salesCount: 2, totalAmount: 4000 },
      { method: 'tarjeta', salesCount: 1, totalAmount: 2000 },
    ]);
  });

  it('las propinas van aparte de la venta y se suman por mozo', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 5000, waiter: 'Ana', tip: 500 });
    await sale('2026-10-10T16:00:00Z', { total: 3000, waiter: 'Ana', tip: 300 });
    await sale('2026-10-10T17:00:00Z', { total: 2000, waiter: 'Beto' });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.summary.totalAmount).toBe(10000); // sin propinas
    expect(r.summary.tipsTotal).toBe(800);
    expect(r.byWaiter.find((w) => w.name === 'Ana')?.tips).toBe(800);
    expect(r.byWaiter.find((w) => w.name === 'Beto')?.tips).toBe(0);
  });

  it('la comisión de cada mozo es lo vendido por el porcentaje que regía en cada venta', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 5000, waiter: 'Ana', commissionPct: 10 });
    await sale('2026-10-10T16:00:00Z', { total: 3000, waiter: 'Ana', commissionPct: 5 }); // el porcentaje se ajustó después
    await sale('2026-10-10T17:00:00Z', { total: 2000, waiter: 'Beto', commissionPct: 5 });
    await sale('2026-10-10T18:00:00Z', { total: 1000, waiter: 'Beto' }); // antes de activar la comisión: no suma

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.byWaiter.find((w) => w.name === 'Ana')?.commission).toBe(650); // 500 + 150
    expect(r.byWaiter.find((w) => w.name === 'Beto')?.commission).toBe(100);
    expect(r.summary.commissionTotal).toBe(750);
  });

  it('informa si el negocio tiene la comisión activada y con qué porcentaje', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { commissionEnabled: true, commissionPct: 7.5 } });
    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });
    expect(r.commission).toEqual({ enabled: true, pct: 7.5 });
    expect(r.summary.commissionTotal).toBe(0);
  });

  it('las ventas sin detalle (sistema anterior) cuentan en los totales pero no en los platos', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 10900 }); // sin items
    await sale('2026-10-10T16:00:00Z', { total: 1000, items: [cafe(1)] });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.summary).toMatchObject({ salesCount: 2, totalAmount: 11900, salesWithoutDetail: 1, itemsSold: 1 });
    expect(r.items).toHaveLength(1);
  });

  it('un rango sin ventas devuelve ceros, no errores', async () => {
    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-12', tz: BA });

    expect(r.summary).toMatchObject({ salesCount: 0, totalAmount: 0, averageTicket: 0 });
    expect(r.byDay).toHaveLength(3);
    expect(r.items).toEqual([]);
  });

  it('nunca mezcla las ventas de otro negocio', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 1000, items: [cafe(1)] });
    await sale('2026-10-10T15:00:00Z', { total: 999999, waiter: 'Ajeno', items: [torta(9)], tenant: otherTenantId });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.summary.totalAmount).toBe(1000);
    expect(r.byWaiter.map((w) => w.name)).toEqual(['Mario']);
    expect(r.items.map((i) => i.name)).toEqual(['Café']);
  });

  it('valida el rango y la zona horaria', async () => {
    await expect(service.sales(tenantId, { from: '2026-10-12', to: '2026-10-10', tz: BA })).rejects.toThrow(BadRequestException);
    await expect(service.sales(tenantId, { from: '2024-01-01', to: '2026-10-10', tz: BA })).rejects.toThrow(BadRequestException);
    await expect(service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: 'Marte/Olympus' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('sin fechas devuelve los últimos 30 días', async () => {
    const r = await service.sales(tenantId, { tz: BA });

    expect(r.byDay).toHaveLength(30);
    expect(r.range.to).toBe(localDay(new Date(), BA));
  });
});

describe('ReportsService.live (resumen del Inicio)', () => {
  let prisma: PrismaService;
  let service: ReportsService;
  let tenantId: string;
  let otherTenantId: string;
  let n = 0;
  // 15:00 en Buenos Aires
  const NOW = new Date('2026-10-14T18:00:00Z');

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new ReportsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A' } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B' } })).id;
  });

  const sale = (date: string, total: number, opts: { openedAt?: string; tenant?: string } = {}) =>
    prisma.sale.create({
      data: {
        tenantId: opts.tenant ?? tenantId,
        checkoutId: `live-${++n}-${Math.random()}`,
        tableName: 'Mesa 1',
        waiterName: 'Mario',
        paymentMethod: 'efectivo',
        grossTotal: total,
        totalAmount: total,
        date: new Date(date),
        tableOpenedAt: opts.openedAt ? new Date(opts.openedAt) : null,
      },
    });

  it('compara hoy con ayer hasta la misma hora y promedia la permanencia', async () => {
    await sale('2026-10-14T12:00:00Z', 1000, { openedAt: '2026-10-14T11:30:00Z' }); // 30 min
    await sale('2026-10-14T15:00:00Z', 2000, { openedAt: '2026-10-14T14:00:00Z' }); // 60 min
    await sale('2026-10-14T20:00:00Z', 5000); // todavía no pasó: no cuenta
    await sale('2026-10-13T10:00:00Z', 1500); // ayer, antes de esta hora: cuenta
    await sale('2026-10-13T20:00:00Z', 9999); // ayer, después de esta hora: no cuenta

    const live = await service.live(tenantId, BA, NOW);
    expect(live.sales).toEqual({ total: 3000, count: 2 });
    expect(live.yesterday).toEqual({ total: 1500, count: 1 });
    expect(live.changePct).toBe(100);
    expect(live.averageStayMinutes).toBe(45);
    expect(live.staysCount).toBe(2);
  });

  it('el día empieza a la medianoche local, no la de UTC', async () => {
    // 01:00 UTC del 14 = 22:00 del 13 en Buenos Aires: es de ayer, no de hoy (aunque en UTC ya sea 14).
    // Tampoco entra en la comparación, que llega solo hasta las 15:00 de ayer.
    await sale('2026-10-14T01:00:00Z', 700);
    const live = await service.live(tenantId, BA, NOW);
    expect(live.sales.total).toBe(0);
    expect(live.yesterday.total).toBe(0);
  });

  it('sin ventas ayer no hay porcentaje, y sin cierres de mesa no hay permanencia', async () => {
    await sale('2026-10-14T12:00:00Z', 1000);
    const live = await service.live(tenantId, BA, NOW);
    expect(live.changePct).toBeNull();
    expect(live.averageStayMinutes).toBeNull();
    expect(live.sales.total).toBe(1000);
  });

  it('muestra una baja como porcentaje negativo', async () => {
    await sale('2026-10-14T12:00:00Z', 500);
    await sale('2026-10-13T12:00:00Z', 1000);
    expect((await service.live(tenantId, BA, NOW)).changePct).toBe(-50);
  });

  it('solo cuenta las ventas del propio negocio', async () => {
    await sale('2026-10-14T12:00:00Z', 1000, { tenant: otherTenantId });
    const live = await service.live(tenantId, BA, NOW);
    expect(live.sales).toEqual({ total: 0, count: 0 });
  });

  it('rechaza una zona horaria inválida', async () => {
    await expect(service.live(tenantId, 'Marte/Olimpo', NOW)).rejects.toThrow(BadRequestException);
  });

  describe('con un turno en curso', () => {
    const SHIFT = new Date('2026-10-14T16:00:00Z'); // 13:00 en Buenos Aires

    it('cuenta solo lo cobrado desde que empezó el turno y no compara con ayer', async () => {
      await sale('2026-10-14T12:00:00Z', 1000, { openedAt: '2026-10-14T11:00:00Z' }); // antes del turno: no cuenta
      await sale('2026-10-14T17:00:00Z', 2000, { openedAt: '2026-10-14T16:20:00Z' }); // 40 min
      await sale('2026-10-13T10:00:00Z', 1500); // ayer: tampoco se compara

      const live = await service.live(tenantId, BA, NOW, SHIFT);

      expect(live.sales).toEqual({ total: 2000, count: 1 });
      expect(live.yesterday).toEqual({ total: 0, count: 0 });
      expect(live.changePct).toBeNull();
      expect(live.averageStayMinutes).toBe(40);
      expect(live.staysCount).toBe(1);
    });

    it('recién comenzado el turno todo está en cero', async () => {
      await sale('2026-10-14T12:00:00Z', 1000, { openedAt: '2026-10-14T11:00:00Z' });

      const live = await service.live(tenantId, BA, NOW, new Date('2026-10-14T17:59:00Z'));

      expect(live.sales).toEqual({ total: 0, count: 0 });
      expect(live.averageStayMinutes).toBeNull();
      expect(live.staysCount).toBe(0);
    });

    it('un turno que cruza la medianoche cuenta también lo del día anterior', async () => {
      await sale('2026-10-14T01:30:00Z', 800); // 22:30 del 13 en Buenos Aires, ya dentro del turno
      await sale('2026-10-14T12:00:00Z', 200);

      const live = await service.live(tenantId, BA, NOW, new Date('2026-10-14T00:00:00Z')); // 21:00 del 13

      expect(live.sales).toEqual({ total: 1000, count: 2 });
    });

    it('un inicio de turno en el futuro se ignora y se muestra el día de hoy como siempre', async () => {
      await sale('2026-10-14T12:00:00Z', 1000);

      const live = await service.live(tenantId, BA, NOW, new Date('2026-10-15T00:00:00Z'));

      expect(live.sales.total).toBe(1000);
    });
  });
});
