import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Destination, PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KitchenService } from './kitchen.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('KitchenService', () => {
  let prisma: PrismaService;
  let service: KitchenService;
  let tenantId: string;
  let otherTenantId: string;
  let tableId: string;
  let coffee: { id: string }; // categoría de barra
  let burger: { id: string }; // categoría de cocina
  let orderBar: string;
  let orderKitchen: string;
  let orderNoCategory: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new KitchenService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Mesa con tres líneas: una de barra, una de cocina y una de un plato sin categoría
  async function setup(opts: { plan: string; split: boolean }) {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', plan: opts.plan, splitKitchenBar: opts.split, kitchenEnabled: true } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B' } })).id;

    const bar = await prisma.category.create({ data: { tenantId, name: 'Bebidas', destination: Destination.BAR } });
    const kitchen = await prisma.category.create({ data: { tenantId, name: 'Comidas', destination: Destination.KITCHEN } });
    coffee = await prisma.menuItem.create({ data: { tenantId, name: 'Cerveza', price: 1, categoryId: bar.id } });
    burger = await prisma.menuItem.create({ data: { tenantId, name: 'Hamburguesa', price: 1, categoryId: kitchen.id } });
    const loose = await prisma.menuItem.create({ data: { tenantId, name: 'Suelto', price: 1 } });

    const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 1', available: false } });
    tableId = table.id;
    const mk = (menuItemId: string) => prisma.order.create({ data: { tableId, menuItemId, quantity: 1 } });
    orderBar = (await mk(coffee.id)).id;
    orderKitchen = (await mk(burger.id)).id;
    orderNoCategory = (await mk(loose.id)).id;
  }

  const names = async (role: Role, destination?: Destination) =>
    (await service.list(tenantId, role, destination)).map((o) => o.itemName).sort();

  describe('sin separar cocina y barra (todo va a cocina)', () => {
    beforeEach(() => setup({ plan: 'pro', split: false }));

    it('cocina y admin ven todo; la barra no tiene nada', async () => {
      expect(await names(Role.KITCHEN)).toEqual(['Cerveza', 'Hamburguesa', 'Suelto']);
      expect(await names(Role.ADMIN)).toEqual(['Cerveza', 'Hamburguesa', 'Suelto']);
      expect(await names(Role.BAR)).toEqual([]);
    });
  });

  describe('separando cocina y barra', () => {
    beforeEach(() => setup({ plan: 'pro', split: true }));

    it('cocina ve lo suyo (incluido lo que no tiene categoría); barra ve solo lo suyo', async () => {
      expect(await names(Role.KITCHEN)).toEqual(['Hamburguesa', 'Suelto']);
      expect(await names(Role.BAR)).toEqual(['Cerveza']);
    });

    it('cada línea informa su destino', async () => {
      const lines = await service.list(tenantId, Role.ADMIN);
      expect(lines.find((l) => l.itemName === 'Cerveza')?.destination).toBe('BAR');
      expect(lines.find((l) => l.itemName === 'Suelto')?.destination).toBe('KITCHEN');
    });

    it('el admin ve todo y puede filtrar por pestaña', async () => {
      expect(await names(Role.ADMIN)).toEqual(['Cerveza', 'Hamburguesa', 'Suelto']);
      expect(await names(Role.ADMIN, Destination.BAR)).toEqual(['Cerveza']);
      expect(await names(Role.ADMIN, Destination.KITCHEN)).toEqual(['Hamburguesa', 'Suelto']);
    });

    it('no se puede cambiar el estado de un pedido de otro sector', async () => {
      await expect(service.setStatus(tenantId, Role.KITCHEN, orderBar, 'READY')).rejects.toThrow(ForbiddenException);
      await expect(service.setStatus(tenantId, Role.BAR, orderKitchen, 'READY')).rejects.toThrow(ForbiddenException);

      await service.setStatus(tenantId, Role.BAR, orderBar, 'READY');
      expect((await prisma.order.findUnique({ where: { id: orderBar } }))?.status).toBe('READY');
    });

    it('al mover varias líneas a la vez, solo se mueven las de su sector', async () => {
      const result = await service.setManyStatus(tenantId, Role.KITCHEN, [orderBar, orderKitchen, orderNoCategory], 'PREPARING');

      expect(result.updated).toBe(2);
      expect((await prisma.order.findUnique({ where: { id: orderBar } }))?.status).toBe('PENDING');
      expect((await prisma.order.findUnique({ where: { id: orderKitchen } }))?.status).toBe('PREPARING');
    });
  });

  describe('plan que no incluye la separación', () => {
    it('aunque haya quedado activada, rige todo a cocina', async () => {
      await setup({ plan: 'basic', split: true });

      expect(await names(Role.KITCHEN)).toEqual(['Cerveza', 'Hamburguesa', 'Suelto']);
      expect(await names(Role.BAR)).toEqual([]);
    });
  });

  describe('cocina opcional', () => {
    beforeEach(async () => {
      await setup({ plan: 'pro', split: true });
      await prisma.tenant.update({ where: { id: tenantId }, data: { kitchenEnabled: false } });
    });

    it('sin habilitar la cocina no hay pantalla ni se pueden cambiar estados', async () => {
      await expect(service.list(tenantId, Role.ADMIN)).rejects.toThrow(ForbiddenException);
      await expect(service.list(tenantId, Role.KITCHEN)).rejects.toThrow(ForbiddenException);
      await expect(service.setStatus(tenantId, Role.ADMIN, orderKitchen, 'READY')).rejects.toThrow(ForbiddenException);
      await expect(service.setManyStatus(tenantId, Role.ADMIN, [orderKitchen], 'READY')).rejects.toThrow(ForbiddenException);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderKitchen } })).status).toBe('PENDING');
    });

    it('separar cocina y barra no rige si no hay cocina, aunque haya quedado activado', async () => {
      expect(await service.isSplit(tenantId)).toBe(false);
    });

    it('al habilitarla vuelve a funcionar', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { kitchenEnabled: true } });
      expect((await service.list(tenantId, Role.ADMIN)).length).toBeGreaterThan(0);
      expect(await service.isSplit(tenantId)).toBe(true);
    });
  });

  describe('aislamiento entre negocios', () => {
    beforeEach(() => setup({ plan: 'pro', split: true }));

    it('no ve ni mueve pedidos de otro negocio', async () => {
      await prisma.tenant.update({ where: { id: otherTenantId }, data: { kitchenEnabled: true } });
      expect(await service.list(otherTenantId, Role.ADMIN)).toEqual([]);
      await expect(service.setStatus(otherTenantId, Role.ADMIN, orderBar, 'READY')).rejects.toThrow(NotFoundException);
      expect((await service.setManyStatus(otherTenantId, Role.ADMIN, [orderBar], 'READY')).updated).toBe(0);
      expect((await prisma.order.findUnique({ where: { id: orderBar } }))?.status).toBe('PENDING');
    });
  });
});
