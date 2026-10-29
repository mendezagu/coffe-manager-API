import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { CategoriesService } from '../categories/categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { SettingsService } from '../settings/settings.service';
import { TablesService } from '../tables/tables.service';
import { MenuService } from './menu.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Carta premium: datos del plato y de la categoría', () => {
  let prisma: PrismaService;
  let menu: MenuService;
  let categories: CategoriesService;
  let tenantId: string;
  let ipN = 0;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    menu = new MenuService(prisma);
    categories = new CategoriesService(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Café Sol', requireOpenRegister: false } })).id;
  });

  it('un plato con solo nombre y precio sigue funcionando: todo lo demás es opcional', async () => {
    const item = await menu.create(tenantId, { name: 'Cortado', price: 2700 });
    expect(item).toMatchObject({ description: null, badge: null, badgeColor: 'terracotta', featured: false });
  });

  it('guarda descripción, etiqueta con color y destacado, sin espacios de más', async () => {
    const item = await menu.create(tenantId, {
      name: 'Torta',
      price: 6500,
      description: '  Bizcocho   de cacao con fudge tibio  ',
      badge: ' Firma Casa ',
      badgeColor: 'red',
      featured: true,
    });
    expect(item).toMatchObject({ description: 'Bizcocho de cacao con fudge tibio', badge: 'Firma Casa', badgeColor: 'red', featured: true });
  });

  it('rechaza textos demasiado largos y colores que no existen', async () => {
    await expect(menu.create(tenantId, { name: 'A', price: 1, description: 'x'.repeat(161) })).rejects.toThrow(BadRequestException);
    await expect(menu.create(tenantId, { name: 'A', price: 1, badge: 'x'.repeat(21) })).rejects.toThrow(BadRequestException);
    await expect(menu.create(tenantId, { name: 'A', price: 1, badgeColor: 'fucsia' })).rejects.toThrow('color');
  });

  it('al editar: vacío borra, y no mandar el campo lo deja como estaba', async () => {
    const item: any = await menu.create(tenantId, { name: 'Torta', price: 1, description: 'Rica', badge: 'Nuevo', featured: true });
    const sameDescription: any = await menu.update(tenantId, item._id, { name: 'Torta 2' });
    expect(sameDescription).toMatchObject({ description: 'Rica', badge: 'Nuevo', featured: true });
    const cleared: any = await menu.update(tenantId, item._id, { description: '', badge: '', featured: false });
    expect(cleared).toMatchObject({ description: null, badge: null, featured: false });
  });

  it('las categorías guardan subtítulo, texto a la derecha y formato', async () => {
    const cat: any = await categories.create(tenantId, { name: 'Cafetería', subtitle: 'Granos tostados en casa', tagline: 'Favoritos del Día', layout: 'hero' });
    expect(cat).toMatchObject({ subtitle: 'Granos tostados en casa', tagline: 'Favoritos del Día', layout: 'hero' });
    const plain: any = await categories.create(tenantId, { name: 'Postres' });
    expect(plain).toMatchObject({ subtitle: null, tagline: null, layout: 'grid' });
    const edited: any = await categories.update(tenantId, plain._id, { layout: 'list', subtitle: 'Dulces' });
    expect(edited).toMatchObject({ layout: 'list', subtitle: 'Dulces' });
    await expect(categories.update(tenantId, plain._id, { layout: 'masonry' })).rejects.toThrow(BadRequestException);
  });

  it('la carta pública trae los datos nuevos y no filtra nada interno', async () => {
    const cat: any = await categories.create(tenantId, { name: 'Cafetería', subtitle: 'Granos tostados', layout: 'list' });
    await menu.create(tenantId, { name: 'Torta', price: 6500, description: 'Con fudge', badge: 'Firma Casa', badgeColor: 'green', featured: true, categoryId: cat._id });
    await new SettingsService(prisma).update(tenantId, { menuPublicEnabled: true });
    const qr = new QrService(prisma, new TablesService(prisma));
    const carta = await qr.publicCarta('cafe-sol', `10.9.0.${++ipN}`);
    expect(carta.menu.categories[0]).toMatchObject({ name: 'Cafetería', subtitle: 'Granos tostados', layout: 'list' });
    expect(carta.menu.items[0]).toMatchObject({ description: 'Con fudge', badge: 'Firma Casa', badgeColor: 'green', featured: true });
    expect(JSON.stringify(carta)).not.toContain('imageKey');
  });
});
