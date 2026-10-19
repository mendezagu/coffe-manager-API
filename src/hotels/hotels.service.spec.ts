import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role, VoucherStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from '../sales/sales.service';
import { HotelsService, MAX_ACTIVE_VOUCHERS_PER_GUEST, VOUCHER_COOLDOWN_MS } from './hotels.service';
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

  const ask = (overrides: Partial<{ tenantId: string; guestName: string; document: string; accessCode: string }> = {}, now?: Date) =>
    hotels.issueVoucher('alpes', { tenantId, guestName: 'Lucía Pérez', document: '30123456', accessCode: 'ALPES-OCT', ...overrides }, now);

  // Suma otro restaurante adherido al hotel
  const addPartner = async (name: string) => {
    const t = await prisma.tenant.create({ data: { name, requireOpenRegister: false } });
    await prisma.hotelPartner.create({ data: { hotelId, tenantId: t.id, discountPct: 5 } });
    return t.id;
  };
  const redeem = (code: string, at = new Date()) =>
    prisma.hotelVoucher.update({ where: { code }, data: { status: VoucherStatus.REDEEMED, redeemedAt: at } });

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

    it('un huésped no acumula más de 3 vouchers sin usar entre todos los restaurantes', async () => {
      const others: string[] = [];
      for (let i = 0; i < MAX_ACTIVE_VOUCHERS_PER_GUEST - 1; i++) others.push(await addPartner(`Extra ${i}`));
      await ask();
      for (const tid of others) await ask({ tenantId: tid });
      const fourth = await addPartner('Cuarto');

      await expect(ask({ tenantId: fourth })).rejects.toThrow(BadRequestException);
      // otra persona (otro documento) sí puede
      await expect(ask({ tenantId: fourth, guestName: 'Otra Persona', document: '40111222' })).resolves.toBeDefined();
    });

    it('cambiar el nombre no sirve para saltear el tope: se reconoce al huésped por su documento', async () => {
      const others = [await addPartner('Extra 1'), await addPartner('Extra 2'), await addPartner('Extra 3')];
      await ask();
      await ask({ tenantId: others[0] });
      await ask({ tenantId: others[1] });

      await expect(ask({ tenantId: others[2], guestName: 'Lucía Pérez Otro' })).rejects.toThrow(BadRequestException);
    });

    it('pedir otro voucher al mismo restaurante devuelve el que ya tiene vigente (no crea otro)', async () => {
      const first = await ask();
      const again = await ask();

      expect(again.code).toBe(first.code);
      expect(again.reused).toBe(true);
      expect(first.reused).toBe(false);
      expect(await prisma.hotelVoucher.count()).toBe(1);
    });

    it('el documento da igual con puntos o espacios, y el nombre sin importar mayúsculas ni tildes', async () => {
      const first = await ask();
      const again = await ask({ document: '30.123.456', guestName: 'lucia  PEREZ' });

      expect(again.code).toBe(first.code);
    });

    it('con el documento de otro huésped no se obtiene su voucher: tiene que coincidir el nombre', async () => {
      await ask();

      await expect(ask({ guestName: 'Alguien Más' })).rejects.toThrow(/otra persona/);
      expect(await prisma.hotelVoucher.count()).toBe(1);
    });

    it('pedidos simultáneos del mismo huésped terminan en un solo voucher', async () => {
      const results = await Promise.all([ask(), ask(), ask(), ask(), ask()]);

      expect(new Set(results.map((r) => r.code)).size).toBe(1);
      expect(await prisma.hotelVoucher.count()).toBe(1);
    });

    it('pide nombre y apellido, y un DNI o pasaporte válido', async () => {
      await expect(ask({ guestName: 'Lucía' })).rejects.toThrow(/nombre y apellido/);
      await expect(ask({ document: '123' })).rejects.toThrow(/DNI o pasaporte/);
      await expect(ask({ document: '' })).rejects.toThrow(BadRequestException);
      await expect(ask({ document: 'AB-1234567' })).resolves.toBeDefined(); // pasaporte
      expect(await prisma.hotelVoucher.count()).toBe(1);
    });

    it('no se guarda el número de documento: solo una huella cifrada y los últimos 3 caracteres', async () => {
      const v = await ask({ document: '30.123.456' });

      const row = await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: v.code } });
      expect(row.guestDocHint).toBe('456');
      expect(row.guestDocHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain('30123456');
      // el cajero ve cómo termina el documento
      expect((await hotels.validate(tenantId, v.code)).documentHint).toBe('456');
    });

    describe('después de usar un voucher en un restaurante', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const HOUR = 60 * 60 * 1000;

      it('no puede pedir otro en ese restaurante hasta pasadas 24 horas', async () => {
        const v = await ask({}, now);
        await redeem(v.code, now);

        await expect(ask({}, new Date(now.getTime() + 1 * HOUR))).rejects.toThrow(/Ya usaste tu voucher en Pizzería\. Podés pedir otro en 23 horas/);
        await expect(ask({}, new Date(now.getTime() + 23.5 * HOUR))).rejects.toThrow(/en menos de 1 hora/);
        expect(await prisma.hotelVoucher.count()).toBe(1);
      });

      it('pasadas las 24 horas puede pedir uno nuevo', async () => {
        const v = await ask({}, now);
        await redeem(v.code, now);

        const next = await ask({}, new Date(now.getTime() + VOUCHER_COOLDOWN_MS + 60_000));

        expect(next.code).not.toBe(v.code);
        expect(next.reused).toBe(false);
      });

      it('la espera es solo en ese restaurante: en otro del hotel puede pedir enseguida', async () => {
        const other = await addPartner('Parrilla Aliada');
        const v = await ask({}, now);
        await redeem(v.code, now);

        await expect(ask({ tenantId: other }, new Date(now.getTime() + HOUR))).resolves.toBeDefined();
      });

      it('la espera es de esa persona: otro huésped puede pedir en ese restaurante', async () => {
        const v = await ask({}, now);
        await redeem(v.code, now);

        await expect(ask({ guestName: 'Otra Persona', document: '40111222' }, new Date(now.getTime() + HOUR))).resolves.toBeDefined();
      });

      it('un voucher que venció sin usarse o que el hotel anuló no genera espera', async () => {
        const v = await ask({}, now);
        await prisma.hotelVoucher.update({ where: { code: v.code }, data: { validTo: new Date(now.getTime() + HOUR) } });
        const afterExpiry = await ask({}, new Date(now.getTime() + 2 * HOUR));
        expect(afterExpiry.code).not.toBe(v.code);

        await prisma.hotelVoucher.update({ where: { code: afterExpiry.code }, data: { status: VoucherStatus.CANCELLED } });
        await expect(ask({}, new Date(now.getTime() + 3 * HOUR))).resolves.toBeDefined();
      });
    });

    it('la pantalla pública del hotel lista sus restaurantes con el descuento', async () => {
      const info = await hotels.publicInfo('alpes');

      expect(info.name).toBe('Hotel Alpes');
      expect(info.restaurants).toEqual([expect.objectContaining({ id: tenantId, name: 'Pizzería', discountPct: 10 })]);
      await expect(hotels.publicInfo('no-existe')).rejects.toThrow(NotFoundException);
    });
  });

  describe('estado de los vouchers que ya tiene el celular', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    const HOUR = 60 * 60 * 1000;
    const statuses = (codes: string[], at = new Date(now.getTime() + HOUR)) => hotels.voucherStatuses('alpes', codes, at);

    it('dice si cada voucher está vigente, canjeado, anulado o vencido, con su restaurante y descuento', async () => {
      const other = await addPartner('Parrilla Aliada');
      const third = await addPartner('Cafetería');
      const fourth = await addPartner('Heladería');
      const vigente = await ask({}, now);
      const canjeado = await ask({ tenantId: other }, now);
      await redeem(canjeado.code, now);
      const anulado = await ask({ tenantId: third }, now);
      await prisma.hotelVoucher.update({ where: { code: anulado.code }, data: { status: VoucherStatus.CANCELLED } });
      const vencido = await ask({ tenantId: fourth }, now);
      await prisma.hotelVoucher.update({ where: { code: vencido.code }, data: { validTo: new Date(now.getTime() - HOUR) } });

      const res = await statuses([vigente.code, canjeado.code, anulado.code, vencido.code]);
      const byCode = Object.fromEntries(res.map((r) => [r.code, r]));

      expect(res).toHaveLength(4);
      expect(byCode[vigente.code]).toEqual(expect.objectContaining({ status: 'ISSUED', restaurantName: 'Pizzería', discountPct: 10, restaurantId: tenantId }));
      expect(byCode[canjeado.code]).toEqual(expect.objectContaining({ status: 'REDEEMED', restaurantName: 'Parrilla Aliada' }));
      expect(byCode[canjeado.code].redeemedAt).toEqual(now);
      expect(byCode[anulado.code].status).toBe('CANCELLED');
      expect(byCode[vencido.code].status).toBe('EXPIRED');
    });

    it('un voucher vigente pasa a vencido al llegar su fecha, sin que nadie lo toque', async () => {
      const v = await ask({}, now);

      expect((await statuses([v.code], new Date(now.getTime() + HOUR)))[0].status).toBe('ISSUED');
      expect((await statuses([v.code], new Date(v.validTo.getTime() + 1000)))[0].status).toBe('EXPIRED');
    });

    it('trae las condiciones de la alianza', async () => {
      await prisma.hotelPartner.updateMany({ data: { conditions: 'Lunes a jueves' } });
      const v = await ask({}, now);

      expect((await statuses([v.code]))[0].conditions).toBe('Lunes a jueves');
    });

    it('acepta códigos en minúsculas o con guiones, y no repite resultados', async () => {
      const v = await ask({}, now);
      const spaced = v.code.slice(0, 3) + '-' + v.code.slice(3);

      const res = await statuses([v.code.toLowerCase(), spaced, v.code]);

      expect(res).toHaveLength(1);
      expect(res[0].code).toBe(v.code);
    });

    it('no devuelve vouchers de otro hotel ni códigos que no existen', async () => {
      const mar = await prisma.hotel.create({ data: { name: 'Hotel Mar', slug: 'mar', accessCode: 'MAR-OCT' } });
      await prisma.hotelPartner.create({ data: { hotelId: mar.id, tenantId, discountPct: 5 } });
      const ajeno = await hotels.issueVoucher('mar', { tenantId, guestName: 'Pedro Soto', document: '30222333', accessCode: 'MAR-OCT' });

      expect(await statuses([ajeno.code, 'ZZZZZZ'])).toEqual([]);
      expect(await statuses([])).toEqual([]);
    });

    it('nunca incluye datos del huésped (nombre, documento ni su huella)', async () => {
      const v = await ask({}, now);

      const text = JSON.stringify(await statuses([v.code]));

      expect(text).not.toContain('Lucía');
      expect(text).not.toContain('Pérez');
      expect(text).not.toContain('30123456');
      expect(text).not.toMatch(/[0-9a-f]{64}/);
      expect(text).not.toContain('guestName');
    });

    it('un hotel que no existe o está dado de baja responde que no se encontró', async () => {
      await expect(hotels.voucherStatuses('no-existe', ['ABC234'])).rejects.toThrow(NotFoundException);
      await prisma.hotel.update({ where: { id: hotelId }, data: { active: false } });
      await expect(statuses(['ABC234'])).rejects.toThrow(NotFoundException);
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
