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
    expect(byName['Café']).toEqual({ name: 'Café', quantity: 5, amount: 2000 + 2700 }); // 2000 + 3000*0,9
    expect(byName['Torta']).toEqual({ name: 'Torta', quantity: 1, amount: 2500 });
    expect(r.items[0].name).toBe('Café'); // ordenado por importe
  });

  it('agrupa por mozo y por método de pago, de mayor a menor', async () => {
    await sale('2026-10-10T15:00:00Z', { total: 1000, waiter: 'Ana', payment: 'tarjeta' });
    await sale('2026-10-10T16:00:00Z', { total: 4000, waiter: 'Beto', payment: 'efectivo' });
    await sale('2026-10-10T17:00:00Z', { total: 500, waiter: 'Ana', payment: 'efectivo' });

    const r = await service.sales(tenantId, { from: '2026-10-10', to: '2026-10-10', tz: BA });

    expect(r.byWaiter).toEqual([
      { name: 'Beto', salesCount: 1, totalAmount: 4000 },
      { name: 'Ana', salesCount: 2, totalAmount: 1500 },
    ]);
    expect(r.byPayment).toEqual([
      { method: 'efectivo', salesCount: 2, totalAmount: 4500 },
      { method: 'tarjeta', salesCount: 1, totalAmount: 1000 },
    ]);
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
