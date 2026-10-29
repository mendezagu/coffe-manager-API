import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Destination, PrismaClient } from '@prisma/client';
import { MenuService } from '../menu/menu.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { CategoriesService } from './categories.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('CategoriesService', () => {
  let prisma: PrismaService;
  let categories: CategoriesService;
  let menu: MenuService;
  let settings: SettingsService;
  let proId: string; // plan que incluye separar cocina y barra
  let basicId: string; // plan que no lo incluye

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    categories = new CategoriesService(prisma);
    menu = new MenuService(prisma);
    settings = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    proId = (await prisma.tenant.create({ data: { name: 'Pro', plan: 'pro' } })).id;
    basicId = (await prisma.tenant.create({ data: { name: 'Basic', plan: 'basic' } })).id;
  });

  it('crea categorías al final y las lista en orden', async () => {
    await categories.create(proId, { name: 'Cafés' });
    await categories.create(proId, { name: 'Tortas' });

    const list = await categories.findAll(proId);

    expect(list.map((c) => c.name)).toEqual(['Cafés', 'Tortas']);
    expect(list.map((c) => c.position)).toEqual([0, 1]);
    expect(list[0].destination).toBe('KITCHEN'); // por defecto
  });

  it('no permite nombres repetidos (ignora tildes y mayúsculas) pero sí en otro negocio', async () => {
    await categories.create(proId, { name: 'Café' });

    await expect(categories.create(proId, { name: '  cafe ' })).rejects.toThrow(ConflictException);
    await expect(categories.create(basicId, { name: 'Café' })).resolves.toBeDefined();
  });

  it('rechaza nombre vacío o demasiado largo', async () => {
    await expect(categories.create(proId, { name: '   ' })).rejects.toThrow(BadRequestException);
    await expect(categories.create(proId, { name: 'x'.repeat(61) })).rejects.toThrow(BadRequestException);
  });

  it('el destino "barra" solo se puede usar si el plan incluye separar cocina y barra', async () => {
    await expect(categories.create(basicId, { name: 'Bebidas', destination: Destination.BAR })).rejects.toThrow(
      ForbiddenException,
    );
    const ok = await categories.create(proId, { name: 'Bebidas', destination: Destination.BAR });
    expect(ok.destination).toBe('BAR');

    const kitchenOne = await categories.create(basicId, { name: 'Comidas' });
    await expect(categories.update(basicId, kitchenOne._id, { destination: Destination.BAR })).rejects.toThrow(ForbiddenException);
  });

  it('una categoría que ya estaba en barra puede renombrarse aunque el plan haya bajado', async () => {
    const bar = await categories.create(proId, { name: 'Bebidas', destination: Destination.BAR });
    await prisma.tenant.update({ where: { id: proId }, data: { plan: 'basic' } });

    const renamed = await categories.update(proId, bar._id, { name: 'Bebidas frías' });

    expect(renamed.name).toBe('Bebidas frías');
    expect(renamed.destination).toBe('BAR');
  });

  it('al borrar una categoría, sus platos quedan sin categoría (no se borran)', async () => {
    const cat = await categories.create(proId, { name: 'Cafés' });
    const item = await menu.create(proId, { name: 'Espresso', price: 1000, categoryId: cat._id });

    await categories.remove(proId, cat._id);

    const after = await prisma.menuItem.findUnique({ where: { id: item._id } });
    expect(after).not.toBeNull();
    expect(after?.categoryId).toBeNull();
  });

  it('reordena las categorías', async () => {
    const a = await categories.create(proId, { name: 'A' });
    const b = await categories.create(proId, { name: 'B' });
    const c = await categories.create(proId, { name: 'C' });

    const list = await categories.reorder(proId, [c._id, a._id, b._id]);

    expect(list.map((x) => x.name)).toEqual(['C', 'A', 'B']);
    await expect(categories.reorder(proId, 'no-es-lista')).rejects.toThrow(BadRequestException);
  });

  it('muestra cuántos platos tiene cada categoría', async () => {
    const cat = await categories.create(proId, { name: 'Cafés' });
    await menu.create(proId, { name: 'Espresso', price: 1, categoryId: cat._id });
    await menu.create(proId, { name: 'Cortado', price: 1, categoryId: cat._id });

    expect((await categories.findAll(proId))[0].itemsCount).toBe(2);
  });

  describe('aislamiento entre negocios', () => {
    it('no se ven, editan ni borran categorías de otro negocio', async () => {
      const foreign = await categories.create(basicId, { name: 'Ajena' });

      expect((await categories.findAll(proId)).map((c) => c.name)).not.toContain('Ajena');
      await expect(categories.update(proId, foreign._id, { name: 'Hackeada' })).rejects.toThrow(NotFoundException);
      await expect(categories.remove(proId, foreign._id)).rejects.toThrow(NotFoundException);
      expect(await prisma.category.findUnique({ where: { id: foreign._id } })).not.toBeNull();
    });

    it('un plato no puede asignarse a una categoría de otro negocio', async () => {
      const foreign = await categories.create(basicId, { name: 'Ajena' });
      const item = await menu.create(proId, { name: 'Plato', price: 1 });

      await expect(menu.create(proId, { name: 'X', price: 1, categoryId: foreign._id })).rejects.toThrow(NotFoundException);
      await expect(menu.update(proId, item._id, { categoryId: foreign._id })).rejects.toThrow(NotFoundException);
    });
  });

  describe('plantilla del plato', () => {
    it('asigna, cambia y quita la categoría de un plato; omitir el campo no la toca', async () => {
      const cat = await categories.create(proId, { name: 'Cafés' });
      const item = await menu.create(proId, { name: 'Espresso', price: 1000 });
      expect(item.categoryId).toBeNull();

      expect((await menu.update(proId, item._id, { categoryId: cat._id }))?.categoryId).toBe(cat._id);
      expect((await menu.update(proId, item._id, { price: 1200 }))?.categoryId).toBe(cat._id); // sin tocar
      expect((await menu.update(proId, item._id, { categoryId: null }))?.categoryId).toBeNull();
    });
  });

  describe('opción de separar cocina y barra (settings)', () => {
    it('un negocio con plan que la incluye puede activarla (si usa la cocina)', async () => {
      const s = await settings.update(proId, { splitKitchenBar: true, kitchenEnabled: true });

      expect(s.features).toContain('kitchen_bar_split');
      expect(s.splitKitchenBar).toBe(true);
      expect(s.kitchenEnabled).toBe(true);
      expect(s.splitActive).toBe(true);
    });

    it('sin cocina habilitada, separar cocina y barra no rige aunque esté elegido', async () => {
      const s = await settings.update(proId, { splitKitchenBar: true });

      expect(s.kitchenEnabled).toBe(false); // apagada por defecto
      expect(s.splitKitchenBar).toBe(true);
      expect(s.splitActive).toBe(false);

      expect((await settings.update(proId, { kitchenEnabled: true })).splitActive).toBe(true);
      expect((await settings.update(proId, { kitchenEnabled: false })).splitActive).toBe(false);
    });

    it('un negocio con plan básico no puede activarla, pero sí dejarla apagada', async () => {
      await expect(settings.update(basicId, { splitKitchenBar: true })).rejects.toThrow(ForbiddenException);

      const s = await settings.update(basicId, { splitKitchenBar: false });
      expect(s.features).not.toContain('kitchen_bar_split');
      expect(s.splitActive).toBe(false);
    });

    it('si el plan baja después de activarla, deja de regir (splitActive=false) sin borrar la elección', async () => {
      await settings.update(proId, { splitKitchenBar: true });
      await prisma.tenant.update({ where: { id: proId }, data: { plan: 'basic' } });

      const s = await settings.get(proId);
      expect(s.splitKitchenBar).toBe(true);
      expect(s.splitActive).toBe(false);
    });
  });
});
