import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { Actor, SalesService } from '../sales/sales.service';
import { HotelsAdminService } from './hotels-admin.service';
import { HotelsService } from './hotels.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Hoteles: administración, alianzas y reporte', () => {
  let prisma: PrismaService;
  let admin: HotelsAdminService;
  let hotels: HotelsService;
  let sales: SalesService;
  let reports: ReportsService;
  let tenantId: string;
  let otherTenantId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    admin = new HotelsAdminService(prisma);
    hotels = new HotelsService(prisma);
    sales = new SalesService(prisma);
    reports = new ReportsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    await prisma.hotel.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Pizzería', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Parrilla', requireOpenRegister: false } })).id;
  });

  it('el dueño de la plataforma da de alta un hotel y vincula restaurantes', async () => {
    const hotel = await admin.createHotel({ name: ' Hotel Alpes ', slug: 'Alpes', accessCode: 'ALPES-OCT' });
    await admin.setPartner(hotel.id, { tenantId, discountPct: 10, conditions: 'Lunes a jueves' });
    await admin.setPartner(hotel.id, { tenantId: otherTenantId, discountPct: 15 });

    const [listed] = await admin.listHotels();
    expect(listed).toEqual(expect.objectContaining({ name: 'Hotel Alpes', slug: 'alpes', accessCode: 'ALPES-OCT' }));
    expect(listed.partners.map((p) => [p.name, p.discountPct])).toEqual([['Parrilla', 15], ['Pizzería', 10]]);
    expect((await hotels.publicInfo('alpes')).restaurants).toHaveLength(2);
  });

  it('valida los datos: dirección repetida o inválida, descuento fuera de rango, hotel o negocio inexistentes', async () => {
    const hotel = await admin.createHotel({ name: 'A', slug: 'a', accessCode: 'X' });

    await expect(admin.createHotel({ name: 'B', slug: 'a', accessCode: 'Y' })).rejects.toThrow(ConflictException);
    await expect(admin.createHotel({ name: 'B', slug: 'con espacios', accessCode: 'Y' })).rejects.toThrow(BadRequestException);
    await expect(admin.createHotel({ name: 'B', accessCode: 'Y' })).rejects.toThrow(BadRequestException);
    await expect(admin.setPartner(hotel.id, { tenantId, discountPct: 0 })).rejects.toThrow(BadRequestException);
    await expect(admin.setPartner(hotel.id, { tenantId, discountPct: 101 })).rejects.toThrow(BadRequestException);
    await expect(admin.setPartner('nada', { tenantId, discountPct: 10 })).rejects.toThrow(NotFoundException);
    await expect(admin.setPartner(hotel.id, { tenantId: 'nada', discountPct: 10 })).rejects.toThrow(NotFoundException);
    await expect(admin.updateHotel('nada', { name: 'Z' })).rejects.toThrow(NotFoundException);
  });

  it('cambiar el código del hotel corta el acceso al código viejo pero no a los vouchers ya emitidos', async () => {
    const hotel = await admin.createHotel({ name: 'A', slug: 'a', accessCode: 'VIEJO' });
    await admin.setPartner(hotel.id, { tenantId, discountPct: 10 });
    const voucher = await hotels.issueVoucher('a', { tenantId, guestName: 'Lucía Pérez', document: '30123456', accessCode: 'VIEJO' });

    await admin.updateHotel(hotel.id, { accessCode: 'NUEVO' });

    await expect(hotels.issueVoucher('a', { tenantId, guestName: 'Pedro Soto', document: '30222333', accessCode: 'VIEJO' })).rejects.toThrow();
    await expect(hotels.issueVoucher('a', { tenantId, guestName: 'Pedro Soto', document: '30222333', accessCode: 'NUEVO' })).resolves.toBeDefined();
    await expect(hotels.validate(tenantId, voucher.code)).resolves.toBeDefined();
  });

  describe('alianzas vistas por el restaurante', () => {
    it('cada restaurante ve y edita solo las suyas', async () => {
      const hotel = await admin.createHotel({ name: 'Hotel Alpes', slug: 'a', accessCode: 'X' });
      await admin.setPartner(hotel.id, { tenantId, discountPct: 10 });
      await admin.setPartner(hotel.id, { tenantId: otherTenantId, discountPct: 20 });
      const [mine] = await admin.listPartnerships(tenantId);

      const updated = await admin.updatePartnership(tenantId, mine.id, { discountPct: 12, conditions: 'Sin feriados', active: false });

      expect(updated).toEqual(expect.objectContaining({ discountPct: 12, conditions: 'Sin feriados', active: false }));
      await expect(admin.updatePartnership(otherTenantId, mine.id, { discountPct: 99 })).rejects.toThrow(NotFoundException);
      await expect(admin.updatePartnership(tenantId, mine.id, { discountPct: 0 })).rejects.toThrow(BadRequestException);
      // pausada: deja de ofrecerse en la pantalla del hotel
      expect((await hotels.publicInfo('a')).restaurants.map((r) => r.id)).toEqual([otherTenantId]);
    });
  });

  it('el reporte de ventas suma lo que trajo cada hotel y lo descontado', async () => {
    const hotel = await admin.createHotel({ name: 'Hotel Alpes', slug: 'a', accessCode: 'X' });
    await admin.setPartner(hotel.id, { tenantId, discountPct: 10 });
    const pizza = await prisma.menuItem.create({ data: { tenantId, name: 'Pizza', price: 1000 } });
    const sell = async (code?: string) => {
      const t = await prisma.table.create({ data: { tenantId, name: `M${Math.random()}`, available: false } });
      await prisma.order.create({ data: { tableId: t.id, menuItemId: pizza.id, quantity: 2 } });
      return sales.checkout(tenantId, cashier, t.id, {
        checkoutId: `co-${Math.random().toString(36).slice(2)}-x`,
        paymentMethod: 'efectivo',
        voucherCode: code,
      });
    };
    const v1 = await hotels.issueVoucher('a', { tenantId, guestName: 'Ana Gómez', document: '30000001', accessCode: 'X' });
    const v2 = await hotels.issueVoucher('a', { tenantId, guestName: 'Beto Ruiz', document: '30000002', accessCode: 'X' });
    await sell(v1.code);
    await sell(v2.code);
    await sell(); // venta común: no cuenta para el hotel

    const report = await reports.sales(tenantId, {});

    expect(report.summary.salesCount).toBe(3);
    expect(report.byHotel).toEqual([
      { hotelId: hotel.id, name: 'Hotel Alpes', salesCount: 2, totalAmount: 3600, discountTotal: 400, averageTicket: 1800 },
    ]);
  });
});
