import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from './settings.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Ajustes: color de marca', () => {
  let prisma: PrismaService;
  let settings: SettingsService;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    settings = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Pizzería', requireOpenRegister: false } })).id;
  });

  it('sin elegir nada rige el verde bosque de siempre', async () => {
    expect((await settings.get(tenantId)).brandColor).toBe('#1b2822');
  });

  it('guarda el color elegido en minúsculas', async () => {
    const saved = await settings.update(tenantId, { brandColor: '#8A2A1C' });
    expect(saved.brandColor).toBe('#8a2a1c');
    expect((await settings.get(tenantId)).brandColor).toBe('#8a2a1c');
  });

  it('rechaza algo que no es un color hexadecimal de 6 dígitos', async () => {
    for (const bad of ['rojo', '#fff', '8a2a1c', 'url(javascript:x)', '#8a2a1c; background:red']) {
      await expect(settings.update(tenantId, { brandColor: bad })).rejects.toThrow(BadRequestException);
    }
    expect((await settings.get(tenantId)).brandColor).toBe('#1b2822');
  });

  it('cambiar otros ajustes no toca el color', async () => {
    await settings.update(tenantId, { brandColor: '#8a2a1c' });
    await settings.update(tenantId, { phone: '123' });
    expect((await settings.get(tenantId)).brandColor).toBe('#8a2a1c');
  });
});
