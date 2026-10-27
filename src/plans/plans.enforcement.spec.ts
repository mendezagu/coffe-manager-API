import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaClient, Role } from '@prisma/client';
import { PlatformTenantsService } from '../hotels/platform-tenants.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { SalesService } from '../sales/sales.service';
import { SettingsService } from '../settings/settings.service';
import { FeatureGuard, RequiresFeature } from './feature.guard';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Planes: el servidor bloquea lo que el plan no incluye', () => {
  let prisma: PrismaService;
  const reflector = new Reflector();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
  });

  const tenantOn = async (plan: string, extra: Record<string, unknown> = {}) =>
    (await prisma.tenant.create({ data: { name: `Local ${plan}`, plan, requireOpenRegister: false, ...extra } })).id;

  // Una ruta cualquiera marcada con @RequiresFeature, para probar la guarda como lo haría Nest
  const guardAllows = async (feature: Parameters<typeof RequiresFeature>[0], tenantId: string) => {
    class Probe {
      handler() {}
    }
    const decorate = RequiresFeature(feature);
    decorate(Probe.prototype, 'handler', Object.getOwnPropertyDescriptor(Probe.prototype, 'handler') as PropertyDescriptor);
    const ctx = {
      getHandler: () => Probe.prototype.handler,
      getClass: () => Probe,
      switchToHttp: () => ({ getRequest: () => ({ user: { tenantId } }) }),
    } as unknown as ExecutionContext;
    return new FeatureGuard(reflector, prisma).canActivate(ctx);
  };

  it('Esencial no pasa reservas, modificadores, reportes completos ni hoteles', async () => {
    const id = await tenantOn('basic');
    for (const f of ['reservations', 'modifiers', 'advanced_reports', 'hotels'] as const) {
      await expect(guardAllows(f, id)).rejects.toThrow(ForbiddenException);
    }
  });

  it('el mensaje dice qué plan la incluye', async () => {
    const id = await tenantOn('basic');
    await expect(guardAllows('reservations', id)).rejects.toThrow('Está disponible desde el plan Pro');
    await expect(guardAllows('hotels', id)).rejects.toThrow('Está disponible desde el plan Beneficios');
  });

  it('Pro pasa todo menos hoteles; Beneficios pasa todo', async () => {
    const pro = await tenantOn('pro');
    for (const f of ['reservations', 'modifiers', 'advanced_reports'] as const) await expect(guardAllows(f, pro)).resolves.toBe(true);
    await expect(guardAllows('hotels', pro)).rejects.toThrow(ForbiddenException);

    const full = await tenantOn('benefits');
    await expect(guardAllows('hotels', full)).resolves.toBe(true);
  });

  it('no se puede activar la comisión ni las reservas sin el plan, pero sí dejarlas como estaban', async () => {
    const settings = new SettingsService(prisma);
    const basic = await tenantOn('basic');
    await expect(settings.update(basic, { commissionEnabled: true, commissionPct: 5 })).rejects.toThrow(ForbiddenException);
    await expect(settings.update(basic, { reservationsEnabled: true })).rejects.toThrow(ForbiddenException);

    // un negocio que ya la tenía prendida (venía de antes) puede guardar sus ajustes sin que el plan se lo impida
    const legacy = await tenantOn('basic', { commissionEnabled: true, commissionPct: 5 });
    await expect(settings.update(legacy, { commissionEnabled: true, commissionPct: 5 })).resolves.toBeDefined();

    const pro = await tenantOn('pro');
    await expect(settings.update(pro, { commissionEnabled: true, commissionPct: 5 })).resolves.toBeDefined();
  });

  it('un negocio sin plan de reservas no las recibe, aunque las tenga encendidas', async () => {
    const reservations = new ReservationsService(prisma);
    await tenantOn('basic', { reservationsEnabled: true, reservationSlug: 'sin-plan' });
    await tenantOn('pro', { reservationsEnabled: true, reservationSlug: 'con-plan' });
    await expect(reservations.tenantBySlug('sin-plan')).rejects.toThrow(NotFoundException);
    await expect(reservations.tenantBySlug('con-plan')).resolves.toBeDefined();
  });

  it('el voucher de hotel solo se canjea en un negocio con el plan que lo incluye', async () => {
    const sales = new SalesService(prisma);
    const pro = await tenantOn('pro');
    const table = await prisma.table.create({ data: { tenantId: pro, name: 'M1', available: false } });
    const item = await prisma.menuItem.create({ data: { tenantId: pro, name: 'Café', price: 1000 } });
    await prisma.order.create({ data: { tableId: table.id, menuItemId: item.id, quantity: 1 } });
    await expect(
      sales.checkout(pro, { id: 'a', name: 'Ana', role: Role.ADMIN }, table.id, { checkoutId: 'plan-voucher-1', paymentMethod: 'efectivo', voucherCode: 'ABC' }),
    ).rejects.toThrow('Hoteles aliados');
  });

  it('la comisión no se aplica a una venta si el plan ya no la incluye', async () => {
    const sales = new SalesService(prisma);
    const basic = await tenantOn('basic', { commissionEnabled: true, commissionPct: 8 });
    const item = await prisma.menuItem.create({ data: { tenantId: basic, name: 'Café', price: 1000 } });
    const waiter = await prisma.waiter.create({ data: { tenantId: basic, name: 'Mario' } });
    const table = await prisma.table.create({ data: { tenantId: basic, name: 'M1', available: false, waiterId: waiter.id } });
    await prisma.order.create({ data: { tableId: table.id, menuItemId: item.id, quantity: 1 } });
    await sales.checkout(basic, { id: 'a', name: 'Ana', role: Role.ADMIN }, table.id, { checkoutId: 'plan-comision-1', paymentMethod: 'efectivo' });
    const sale = await prisma.sale.findFirstOrThrow({ where: { tenantId: basic } });
    expect(sale.commissionPct).toBe(0);
  });

  it('la Consola cambia el plan de un restaurante, y rechaza planes inexistentes o locales ajenos', async () => {
    const platform = new PlatformTenantsService(prisma);
    const id = await tenantOn('pro');
    await expect(platform.setPlan(id, 'basic')).resolves.toMatchObject({ plan: 'basic' });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).plan).toBe('basic');
    await expect(platform.setPlan(id, 'gratis')).rejects.toThrow(BadRequestException);
    await expect(platform.setPlan('00000000-0000-0000-0000-000000000000', 'pro')).rejects.toThrow(NotFoundException);
  });
});
