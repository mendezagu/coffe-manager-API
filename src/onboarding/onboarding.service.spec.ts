import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OnboardingService } from './onboarding.service';

// Corre contra la base de pruebas (coffee_manager_test), nunca contra la de desarrollo.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('OnboardingService', () => {
  let prisma: PrismaService;
  let service: OnboardingService;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new OnboardingService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A' } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Negocio B' } })).id;
  });

  it('un negocio nuevo arranca con el asistente pendiente y sin datos', async () => {
    const status = await service.status(tenantId);
    expect(status.done).toBe(false);
    expect(status.counts.menuItems).toBe(0);
    expect(status.counts.tables).toBe(0);
    expect(status.templates.map((t) => t.key)).toContain('cafeteria');
  });

  it('la plantilla crea categorías y platos marcados como ejemplo, solo en ese negocio', async () => {
    const result = await service.applyTemplate(tenantId, 'cafeteria');
    expect(result).toEqual({ items: 9, categories: 3 });

    const status = await service.status(tenantId);
    expect(status.counts.exampleItems).toBe(9);
    expect(status.counts.categories).toBe(3);
    expect((await service.status(otherTenantId)).counts.menuItems).toBe(0);
  });

  it('no deja cargar la plantilla si ya hay platos, ni con una plantilla inexistente', async () => {
    await prisma.menuItem.create({ data: { tenantId, name: 'Mi plato', price: 1000 } });
    await expect(service.applyTemplate(tenantId, 'cafeteria')).rejects.toBeInstanceOf(ConflictException);
    await expect(service.applyTemplate(otherTenantId, 'no-existe')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('borrar el ejemplo conserva los platos que el dueño ya editó y su categoría', async () => {
    await service.applyTemplate(tenantId, 'cafeteria');
    const cafe = await prisma.menuItem.findFirstOrThrow({ where: { tenantId, name: 'Café' } });
    await prisma.menuItem.update({ where: { id: cafe.id }, data: { isExample: false, price: 3000 } });

    const removed = await service.removeTemplate(tenantId);
    expect(removed).toEqual({ items: 8, categories: 2 });

    const left = await prisma.menuItem.findMany({ where: { tenantId } });
    expect(left.map((i) => i.name)).toEqual(['Café']);
    const categories = await prisma.category.findMany({ where: { tenantId } });
    expect(categories.map((c) => c.name)).toEqual(['Bebidas calientes']);
    expect(categories[0].isExample).toBe(false);
  });

  it('crea mesas en lote siguiendo la numeración existente', async () => {
    await service.createTables(tenantId, 3);
    await service.createTables(tenantId, 2);
    const tables = await prisma.table.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
    expect(tables.map((t) => t.name)).toEqual(['Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5']);
    await expect(service.createTables(tenantId, 0)).rejects.toThrow();
    await expect(service.createTables(tenantId, 101)).rejects.toThrow();
  });
});
