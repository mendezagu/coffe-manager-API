import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role, VoucherStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from '../sales/sales.service';
import { HotelsService, MAX_ACTIVE_VOUCHERS_PER_GUEST } from './hotels.service';
import { normalizeCode } from './vouchers.logic';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Hoteles aliados: vouchers y descuento en el cobro', () => {
  let prisma: PrismaService;
  let hotels: HotelsService;
  let sales: SalesService;
  let tenantId: string;
  let otherTenantId: string;
  let hotelId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    hotels = new HotelsService(prisma);
    sales = new SalesService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    await prisma.hotel.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Pizzería', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Parrilla', requireOpenRegister: false } })).id;
    hotelId = (await prisma.hotel.create({ data: { name: 'Hotel Alpes', slug: 'alpes', accessCode: 'ALPES-OCT' } })).id;
    await prisma.hotelPartner.create({ data: { hotelId, tenantId, discountPct: 10 } });
  });

  const ask = (overrides: Partial<{ tenantId: string; guestName: string; accessCode: string }> = {}) =>
    hotels.issueVoucher('alpes', { tenantId, guestName: 'Lucía Pérez', accessCode: 'ALPES-OCT', ...overrides });

  let n = 0;
  const id = () => `checkout-${++n}-${Math.random().toString(36).slice(2)}`;

  // Mesa con una pizza ($1000 x2) y, opcionalmente, un plato en promo ($500)
  async function table(tid = tenantId, { promo = true }: { promo?: boolean } = {}) {
    const pizza = await prisma.menuItem.create({ data: { tenantId: tid, name: 'Pizza', price: 1000 } });
    const waiter = await prisma.waiter.create({ data: { tenantId: tid, name: 'Mario' } });
    const t = await prisma.table.create({ data: { tenantId: tid, name: 'Mesa 1', available: false, waiterId: waiter.id } });
    await prisma.order.create({ data: { tableId: t.id, menuItemId: pizza.id, quantity: 2 } });
    if (promo) {
      const combo = await prisma.menuItem.create({ data: { tenantId: tid, name: 'Combo', price: 500, isPromo: true } });
      await prisma.order.create({ data: { tableId: t.id, menuItemId: combo.id, quantity: 1 } });
    }
    return t;
  }

  describe('pedir un voucher', () => {
    it('con el código vigente del hotel se emite un voucher para ese restaurante, con el descuento fijado', async () => {
      const v = await ask();

      expect(v.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
      expect(v.discountPct).toBe(10);
      expect(v.restaurantName).toBe('Pizzería');
      expect(v.validTo.getTime()).toBeGreaterThan(Date.now() + 2.9 * DAY);

      // si el restaurante cambia el descuento después, el voucher ya emitido conserva el suyo
      await prisma.hotelPartner.updateMany({ data: { discountPct: 25 } });
      expect((await hotels.validate(tenantId, v.code)).discountPct).toBe(10);
    });

    it('el código del hotel se acepta sin importar mayúsculas ni guiones', async () => {
      await expect(ask({ accessCode: ' alpes oct ' })).resolves.toBeDefined();
    });

    it('rechaza un código de hotel incorrecto y un restaurante que no es del hotel', async () => {
      await expect(ask({ accessCode: 'OTRO' })).rejects.toThrow(ForbiddenException);
      await expect(ask({ tenantId: otherTenantId })).rejects.toThrow(NotFoundException);
      expect(await prisma.hotelVoucher.count()).toBe(0);
    });

    it('un restaurante dado de baja del hotel deja de ofrecerse', async () => {
      await prisma.hotelPartner.updateMany({ data: { active: false } });

      await expect(ask()).rejects.toThrow(NotFoundException);
      expect((await hotels.publicInfo('alpes')).restaurants).toEqual([]);
    });

    it('un huésped no acumula más de 3 vouchers sin usar', async () => {
      for (let i = 0; i < MAX_ACTIVE_VOUCHERS_PER_GUEST; i++) await ask();

      await expect(ask({ guestName: 'lucía pérez' })).rejects.toThrow(BadRequestException);
      await expect(ask({ guestName: 'Otra Persona' })).resolves.toBeDefined();
    });

    it('la pantalla pública del hotel lista sus restaurantes con el descuento', async () => {
      const info = await hotels.publicInfo('alpes');

      expect(info.name).toBe('Hotel Alpes');
      expect(info.restaurants).toEqual([expect.objectContaining({ id: tenantId, name: 'Pizzería', discountPct: 10 })]);
      await expect(hotels.publicInfo('no-existe')).rejects.toThrow(NotFoundException);
    });
  });

  describe('validar en el restaurante', () => {
    it('devuelve el hotel, el huésped y el descuento sin gastar el voucher', async () => {
      const v = await ask();

      const checked = await hotels.validate(tenantId, v.code.toLowerCase());

      expect(checked).toEqual(expect.objectContaining({ hotelName: 'Hotel Alpes', guestName: 'Lucía Pérez', discountPct: 10 }));
      expect((await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: v.code } })).status).toBe(VoucherStatus.ISSUED);
    });

    it('un voucher de otro restaurante, inexistente, vencido o anulado se rechaza', async () => {
      const v = await ask();

      await expect(hotels.validate(otherTenantId, v.code)).rejects.toThrow(/no existe/);
      await expect(hotels.validate(tenantId, 'ZZZZZZ')).rejects.toThrow(/no existe/);

      await prisma.hotelVoucher.update({ where: { code: v.code }, data: { validTo: new Date(Date.now() - 1000) } });
      await expect(hotels.validate(tenantId, v.code)).rejects.toThrow(/venció/);

      await prisma.hotelVoucher.update({ where: { code: v.code }, data: { status: VoucherStatus.CANCELLED } });
      await expect(hotels.validate(tenantId, v.code)).rejects.toThrow(/anulado/);
    });

    it('si el hotel se da de baja, sus vouchers dejan de valer', async () => {
      const v = await ask();
      await prisma.hotel.update({ where: { id: hotelId }, data: { active: false } });

      await expect(hotels.validate(tenantId, v.code)).rejects.toThrow(/ya no está adherido/);
    });
  });

  describe('cobrar con voucher', () => {
    it('descuenta el % sobre lo que no es promo, gasta el voucher y deja el hotel en la venta', async () => {
      const v = await ask();
      const t = await table(); // pizza 2x1000 + combo promo 500

      const sale = await sales.checkout(tenantId, cashier, t.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code });

      expect(sale.grossTotal).toBe(2500);
      expect(sale.discountTotal).toBe(200); // 10% de 2000; la promo no se toca
      expect(sale.totalAmount).toBe(2300);
      expect(sale.globalDiscountPct).toBe(10);
      expect(sale.hotelId).toBe(hotelId);
      const stored = await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: v.code } });
      expect(stored.status).toBe(VoucherStatus.REDEEMED);
      expect(stored.redeemedAt).not.toBeNull();
      expect(sale.voucherId).toBe(stored.id);
    });

    it('un voucher sirve para una sola mesa', async () => {
      const v = await ask();
      const first = await table();
      await sales.checkout(tenantId, cashier, first.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code });
      const second = await prisma.table.create({ data: { tenantId, name: 'Mesa 2', available: false } });
      const pizza = await prisma.menuItem.findFirstOrThrow({ where: { tenantId, name: 'Pizza' } });
      await prisma.order.create({ data: { tableId: second.id, menuItemId: pizza.id, quantity: 1 } });

      await expect(
        sales.checkout(tenantId, cashier, second.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
      ).rejects.toThrow(ConflictException);

      expect(await prisma.sale.count()).toBe(1);
      expect(await prisma.order.count({ where: { tableId: second.id } })).toBe(1);
    });

    it('si dos cobros intentan usar el mismo voucher a la vez, solo uno lo consigue', async () => {
      const v = await ask();
      const a = await table();
      const b = await prisma.table.create({ data: { tenantId, name: 'Mesa 2', available: false } });
      const pizza = await prisma.menuItem.findFirstOrThrow({ where: { tenantId, name: 'Pizza' } });
      await prisma.order.create({ data: { tableId: b.id, menuItemId: pizza.id, quantity: 1 } });

      const results = await Promise.allSettled([
        sales.checkout(tenantId, cashier, a.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
        sales.checkout(tenantId, cashier, b.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.sale.count()).toBe(1);
    });

    it('reintentar el mismo cobro devuelve la misma venta y no vuelve a gastar nada', async () => {
      const v = await ask();
      const t = await table();
      const checkoutId = id();

      const first = await sales.checkout(tenantId, cashier, t.id, { checkoutId, paymentMethod: 'efectivo', voucherCode: v.code });
      const again = await sales.checkout(tenantId, cashier, t.id, { checkoutId, paymentMethod: 'efectivo', voucherCode: v.code });

      expect(again._id).toBe(first._id);
      expect(await prisma.sale.count()).toBe(1);
    });

    it('si el cobro falla, el voucher no se gasta', async () => {
      const v = await ask();
      const t = await table();

      // pagos que no suman la cuenta con descuento
      await expect(
        sales.checkout(tenantId, cashier, t.id, { checkoutId: id(), payments: [{ method: 'efectivo', amount: 2500 }], voucherCode: v.code }),
      ).rejects.toThrow(/Los pagos suman/);

      expect((await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: v.code } })).status).toBe(VoucherStatus.ISSUED);
      expect(await prisma.order.count({ where: { tableId: t.id } })).toBe(2);
    });

    it('no se acumula con descuentos manuales', async () => {
      const v = await ask();
      const t = await table();
      const admin: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN };

      await expect(
        sales.checkout(tenantId, admin, t.id, { checkoutId: id(), paymentMethod: 'efectivo', globalDiscount: 5, voucherCode: v.code }),
      ).rejects.toThrow(/no se acumula/);
    });

    it('el cajero puede usar el voucher aunque el negocio no le haya habilitado los descuentos', async () => {
      const v = await ask();
      const t = await table();

      await expect(
        sales.checkout(tenantId, cashier, t.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
      ).resolves.toBeDefined();
      // y sin voucher sigue sin poder descontar
      const t2 = await prisma.table.create({ data: { tenantId, name: 'Mesa 2', available: false } });
      const pizza = await prisma.menuItem.findFirstOrThrow({ where: { tenantId, name: 'Pizza' } });
      await prisma.order.create({ data: { tableId: t2.id, menuItemId: pizza.id, quantity: 1 } });
      await expect(
        sales.checkout(tenantId, cashier, t2.id, { checkoutId: id(), paymentMethod: 'efectivo', globalDiscount: 10 }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('si todo lo que se cobra es promo, el voucher se rechaza y no se quema', async () => {
      const v = await ask();
      const combo = await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 500, isPromo: true } });
      const t = await prisma.table.create({ data: { tenantId, name: 'Mesa 1', available: false } });
      await prisma.order.create({ data: { tableId: t.id, menuItemId: combo.id, quantity: 1 } });

      await expect(
        sales.checkout(tenantId, cashier, t.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
      ).rejects.toThrow(/solo ítems en promo/);

      expect((await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: v.code } })).status).toBe(VoucherStatus.ISSUED);
    });

    it('un voucher de otro restaurante no vale en este cobro', async () => {
      const v = await ask();
      const t = await table(otherTenantId);

      await expect(
        sales.checkout(otherTenantId, cashier, t.id, { checkoutId: id(), paymentMethod: 'efectivo', voucherCode: v.code }),
      ).rejects.toThrow(/no existe/);
    });
  });

  it('normalizeCode ignora mayúsculas, espacios y guiones', () => {
    expect(normalizeCode(' ab-c 2 ')).toBe('ABC2');
    expect(normalizeCode(undefined)).toBe('');
  });
});
