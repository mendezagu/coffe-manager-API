import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { TablesService } from '../tables/tables.service';
import { QrService } from './qr.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Carta online (pública, sin código)', () => {
  let prisma: PrismaService;
  let qr: QrService;
  let settings: SettingsService;

  let ipCounter = 0;
  const ip = () => `10.1.0.${++ipCounter}`;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    qr = new QrService(prisma, new TablesService(prisma));
    settings = new SettingsService(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
  });

  async function tenantWithMenu(plan = 'basic') {
    const tenant = await prisma.tenant.create({ data: { name: 'Café Sol', plan, requireOpenRegister: false } });
    const cat = await prisma.category.create({ data: { tenantId: tenant.id, name: 'Cafés' } });
    await prisma.menuItem.create({ data: { tenantId: tenant.id, name: 'Cortado', price: 2700, categoryId: cat.id } });
    await prisma.menuItem.create({ data: { tenantId: tenant.id, name: 'Medialuna', price: 1200 } });
    return tenant;
  }

  it('al activarla se arma una dirección con el nombre del local, y la carta se ve sin sesión ni código', async () => {
    const t = await tenantWithMenu();
    const saved = await settings.update(t.id, { menuPublicEnabled: true });
    expect(saved.menuSlug).toBe('cafe-sol');

    const carta = await qr.publicCarta('cafe-sol', ip());
    expect(carta.business.name).toBe('Café Sol');
    expect(carta.menu.items.map((i) => i.name).sort()).toEqual(['Cortado', 'Medialuna']);
    expect(carta.menu.categories.map((c) => c.name)).toEqual(['Cafés']);
  });

  it('funciona en cualquier plan, también en Esencial', async () => {
    const t = await tenantWithMenu('basic');
    await settings.update(t.id, { menuPublicEnabled: true });
    await expect(qr.publicCarta('cafe-sol', ip())).resolves.toBeDefined();
  });

  it('apagada o inexistente responde lo mismo: no revela si el local existe', async () => {
    const t = await tenantWithMenu();
    await settings.update(t.id, { menuPublicEnabled: true });
    await settings.update(t.id, { menuPublicEnabled: false });
    await expect(qr.publicCarta('cafe-sol', ip())).rejects.toThrow(NotFoundException);
    await expect(qr.publicCarta('no-existe', ip())).rejects.toThrow(NotFoundException);
  });

  it('no filtra datos internos del local (costos, claves, códigos)', async () => {
    const t = await tenantWithMenu();
    await settings.update(t.id, { menuPublicEnabled: true });
    const json = JSON.stringify(await qr.publicCarta('cafe-sol', ip()));
    for (const secret of ['loginCode', 'passwordHash', 'unitCost', 'taxId', 'plan', 'qrToken']) expect(json).not.toContain(secret);
  });

  it('dos locales con el mismo nombre reciben direcciones distintas', async () => {
    const a = await tenantWithMenu();
    const b = await prisma.tenant.create({ data: { name: 'Café Sol', requireOpenRegister: false } });
    const sa = await settings.update(a.id, { menuPublicEnabled: true });
    const sb = await settings.update(b.id, { menuPublicEnabled: true });
    expect(sa.menuSlug).not.toBe(sb.menuSlug);
  });
});
