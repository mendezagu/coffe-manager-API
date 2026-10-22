import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from './settings.service';

// Turno en curso del negocio: lo ven igual todos los dispositivos. Corre contra la base de pruebas.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('SettingsService · turno en curso', () => {
  let prisma: PrismaService;
  let service: SettingsService;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A' } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Negocio B' } })).id;
  });

  it('un negocio nuevo no tiene turno en curso', async () => {
    expect(await service.shift(tenantId)).toEqual({ startedAt: null });
  });

  it('comenzar un turno lo deja guardado para todos los dispositivos del negocio', async () => {
    const before = Date.now();
    const { startedAt } = await service.startShift(tenantId);

    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((await service.shift(tenantId)).startedAt).toEqual(startedAt);
  });

  it('el turno de un negocio no cambia el de otro', async () => {
    await service.startShift(tenantId);

    expect(await service.shift(otherTenantId)).toEqual({ startedAt: null });
  });

  it('un turno nuevo reemplaza al anterior', async () => {
    const first = (await service.startShift(tenantId)).startedAt;
    await new Promise((r) => setTimeout(r, 15));
    const second = (await service.startShift(tenantId)).startedAt;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect((await service.shift(tenantId)).startedAt).toEqual(second);
  });

  it('un negocio que no existe da error', async () => {
    await expect(service.shift('no-existe')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.startShift('no-existe')).rejects.toBeInstanceOf(NotFoundException);
  });
});
