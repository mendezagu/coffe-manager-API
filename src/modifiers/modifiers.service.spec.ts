import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ModifierSelection, PrismaClient, Role } from '@prisma/client';
import { KitchenService } from '../kitchen/kitchen.service';
import { MenuService } from '../menu/menu.service';
import { PrismaService } from '../prisma/prisma.service';
import { Actor, SalesService } from '../sales/sales.service';
import { TablesService } from '../tables/tables.service';
import { ModifiersService } from './modifiers.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Modificadores', () => {
  let prisma: PrismaService;
  let modifiers: ModifiersService;
  let menu: MenuService;
  let tables: TablesService;
  let sales: SalesService;
  let kitchen: KitchenService;
  let tenantId: string;
  let otherTenantId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    modifiers = new ModifiersService(prisma);
    menu = new MenuService(prisma);
    tables = new TablesService(prisma);
    sales = new SalesService(prisma);
    kitchen = new KitchenService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', plan: 'pro', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B', requireOpenRegister: false } })).id;
  });

  // Café con dos modificadores: Tamaño (una opción, obligatorio) y Extras (varias, opcional)
  async function cafeSetup() {
    const size = await modifiers.create(tenantId, {
      name: 'Tamaño',
      selection: ModifierSelection.SINGLE,
      required: true,
      options: [
        { name: 'Chico', priceDelta: 0 },
        { name: 'Grande', priceDelta: 500 },
      ],
    });
    const extras = await modifiers.create(tenantId, {
      name: 'Extras',
      selection: ModifierSelection.MULTIPLE,
      required: false,
      options: [
        { name: 'Leche de almendras', priceDelta: 300 },
        { name: 'Shot extra', priceDelta: 400 },
      ],
    });
    const cafe = await menu.create(tenantId, { name: 'Café', price: 1000, modifierGroupIds: [size._id, extras._id] });
    const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 1', available: false } });
    const opt = (g: typeof size, name: string) => g.options.find((o) => o.name === name)!._id;
    return {
      size, extras, cafe, table,
      chico: opt(size, 'Chico'), grande: opt(size, 'Grande'),
      almendras: opt(extras, 'Leche de almendras'), shot: opt(extras, 'Shot extra'),
    };
  }

  describe('gestión de modificadores', () => {
    it('crea un modificador con sus opciones, en orden, y lo lista', async () => {
      const g = await modifiers.create(tenantId, {
        name: 'Leche',
        options: [{ name: 'Entera' }, { name: 'Almendras', priceDelta: 300 }],
      });

      expect(g.selection).toBe('SINGLE');
      expect(g.required).toBe(false);
      expect(g.options.map((o) => [o.name, o.priceDelta, o.position])).toEqual([['Entera', 0, 0], ['Almendras', 300, 1]]);
      expect((await modifiers.findAll(tenantId)).map((x) => x.name)).toEqual(['Leche']);
    });

    it('valida nombre, opciones, precios y repetidos', async () => {
      await expect(modifiers.create(tenantId, { name: '  ', options: [{ name: 'a' }] })).rejects.toThrow(BadRequestException);
      await expect(modifiers.create(tenantId, { name: 'Leche', options: [] })).rejects.toThrow(BadRequestException);
      await expect(modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'A', priceDelta: NaN }] })).rejects.toThrow(BadRequestException);
      await expect(modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Sí' }, { name: ' si ' }] })).rejects.toThrow(ConflictException);

      await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Entera' }] });
      await expect(modifiers.create(tenantId, { name: 'leche', options: [{ name: 'X' }] })).rejects.toThrow(ConflictException);
      await expect(modifiers.create(otherTenantId, { name: 'Leche', options: [{ name: 'X' }] })).resolves.toBeDefined();
    });

    it('al editar: renombra, cambia precios, agrega opciones y borra las que faltan', async () => {
      const g = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Entera' }, { name: 'Descremada' }] });
      const entera = g.options[0]._id;

      const edited = await modifiers.update(tenantId, g._id, {
        name: 'Tipo de leche',
        required: true,
        options: [{ id: entera, name: 'Entera', priceDelta: 100 }, { name: 'Soja', priceDelta: 250 }],
      });

      expect(edited.name).toBe('Tipo de leche');
      expect(edited.required).toBe(true);
      expect(edited.options.map((o) => [o.name, o.priceDelta])).toEqual([['Entera', 100], ['Soja', 250]]);
      expect(await prisma.modifierOption.count({ where: { groupId: g._id } })).toBe(2);
    });

    it('no deja editar opciones de otro modificador', async () => {
      const a = await modifiers.create(tenantId, { name: 'A', options: [{ name: 'a1' }] });
      const b = await modifiers.create(tenantId, { name: 'B', options: [{ name: 'b1' }] });

      await expect(modifiers.update(tenantId, a._id, { options: [{ id: b.options[0]._id, name: 'robada' }] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('borrar un modificador lo quita de los platos (no borra los platos)', async () => {
      const { size, cafe } = await cafeSetup();

      await modifiers.remove(tenantId, size._id);

      const items = await menu.findAll(tenantId);
      expect(items.find((i) => i._id === cafe._id)?.modifierGroupIds).toHaveLength(1);
    });

    it('ofrece el modificador en todos los platos de una categoría', async () => {
      const cat = await prisma.category.create({ data: { tenantId, name: 'Cafés' } });
      const a = await menu.create(tenantId, { name: 'Espresso', price: 1, categoryId: cat.id });
      const b = await menu.create(tenantId, { name: 'Cortado', price: 1, categoryId: cat.id });
      const other = await menu.create(tenantId, { name: 'Torta', price: 1 });
      const g = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Entera' }] });

      const result = await modifiers.applyToCategory(tenantId, g._id, cat.id);
      expect(result).toEqual({ assigned: 2, categoryItems: 2 });
      // repetir no duplica
      expect((await modifiers.applyToCategory(tenantId, g._id, cat.id)).assigned).toBe(0);

      const items = await menu.findAll(tenantId);
      expect(items.find((i) => i._id === a._id)?.modifierGroupIds).toEqual([g._id]);
      expect(items.find((i) => i._id === b._id)?.modifierGroupIds).toEqual([g._id]);
      expect(items.find((i) => i._id === other._id)?.modifierGroupIds).toEqual([]);
    });

    it('un plato solo puede ofrecer modificadores de su propio negocio', async () => {
      const foreign = await modifiers.create(otherTenantId, { name: 'Ajeno', options: [{ name: 'x' }] });

      await expect(menu.create(tenantId, { name: 'Café', price: 1, modifierGroupIds: [foreign._id] })).rejects.toThrow(NotFoundException);
      await expect(modifiers.update(tenantId, foreign._id, { name: 'Hackeado' })).rejects.toThrow(NotFoundException);
      await expect(modifiers.remove(tenantId, foreign._id)).rejects.toThrow(NotFoundException);
      expect(await modifiers.findAll(tenantId)).toEqual([]);
    });

    it('editar un plato sin mandar modifierGroupIds no toca sus modificadores', async () => {
      const { cafe } = await cafeSetup();

      const updated = await menu.update(tenantId, cafe._id, { price: 1200 });

      expect(updated?.modifierGroupIds).toHaveLength(2);
      expect((await menu.update(tenantId, cafe._id, { modifierGroupIds: [] }))?.modifierGroupIds).toEqual([]);
    });
  });

  describe('pedir un plato con modificadores', () => {
    it('guarda una copia de las opciones elegidas (nombre y precio)', async () => {
      const s = await cafeSetup();

      const result = await tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.grande, s.almendras] }]);

      expect(result.orders).toHaveLength(1);
      expect(result.orders[0].modifiers.map((m) => [m.group, m.name, m.priceDelta])).toEqual([
        ['Tamaño', 'Grande', 500],
        ['Extras', 'Leche de almendras', 300],
      ]);
    });

    it('exige elegir en un grupo obligatorio', async () => {
      const s = await cafeSetup();

      await expect(tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1 }])).rejects.toThrow(/Tamaño/);
      await expect(tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.almendras] }])).rejects.toThrow(
        BadRequestException,
      );
      expect(await prisma.order.count({ where: { tableId: s.table.id } })).toBe(0);
    });

    it('un grupo de una sola opción no admite dos', async () => {
      const s = await cafeSetup();

      await expect(
        tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.chico, s.grande] }]),
      ).rejects.toThrow(/una sola opción/);
    });

    it('rechaza opciones que el plato no ofrece, de otro negocio o desactivadas', async () => {
      const s = await cafeSetup();
      const torta = await menu.create(tenantId, { name: 'Torta', price: 2000 }); // sin modificadores
      const foreign = await modifiers.create(otherTenantId, { name: 'Ajeno', options: [{ name: 'x' }] });

      await expect(tables.addItems(tenantId, s.table.id, [{ id: torta._id, quantity: 1, modifiers: [s.grande] }])).rejects.toThrow(BadRequestException);
      await expect(
        tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.chico, foreign.options[0]._id] }]),
      ).rejects.toThrow(BadRequestException);

      await prisma.modifierOption.update({ where: { id: s.grande }, data: { active: false } });
      await expect(tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.grande] }])).rejects.toThrow(BadRequestException);
    });

    it('un plato sin modificadores sigue funcionando igual', async () => {
      const torta = await menu.create(tenantId, { name: 'Torta', price: 2000 });
      const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 2' } });

      const result = await tables.addItems(tenantId, table.id, [{ id: torta._id, quantity: 2 }]);

      expect(result.orders[0].modifiers).toEqual([]);
    });

    it('fusiona líneas solo si tienen las mismas opciones', async () => {
      const s = await cafeSetup();
      const add = (modifiers: string[]) => tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers }]);

      await add([s.chico]);
      await add([s.chico]); // igual: se suma
      await add([s.grande]); // distinto: línea aparte
      const result = await add([s.chico, s.shot]); // distinto: línea aparte

      expect(result.orders).toHaveLength(3);
      expect(result.orders.find((o) => o.modifiers.length === 1 && o.modifiers[0].name === 'Chico')?.quantity).toBe(2);
    });

    it('el pedido conserva su copia aunque después se edite o borre el modificador', async () => {
      const s = await cafeSetup();
      await tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.grande] }]);

      await modifiers.update(tenantId, s.size._id, { options: [{ name: 'Mediano', priceDelta: 50 }] }); // reemplaza todo
      await modifiers.remove(tenantId, s.size._id);

      const order = (await tables.findOne(tenantId, s.table.id)).orders[0];
      expect(order.modifiers[0]).toMatchObject({ name: 'Grande', priceDelta: 500 });
    });
  });

  describe('cobro con modificadores', () => {
    it('el precio de cada unidad incluye lo que sumaron las opciones, y el detalle las conserva', async () => {
      const s = await cafeSetup();
      await tables.addItems(tenantId, s.table.id, [
        { id: s.cafe._id, quantity: 2, modifiers: [s.grande, s.almendras] }, // 1000 + 500 + 300 = 1800 c/u
        { id: s.cafe._id, quantity: 1, modifiers: [s.chico] }, // 1000
      ]);

      const sale = await sales.checkout(tenantId, cashier, s.table.id, { checkoutId: 'checkout-0001', paymentMethod: 'efectivo' });

      expect(sale.grossTotal).toBe(4600); // 2 x 1800 + 1000
      expect(sale.totalAmount).toBe(4600);
      const big = sale.items?.find((i) => i.unitPrice === 1800);
      expect(big?.quantity).toBe(2);
      expect(big?.modifiers.map((m) => m.name)).toEqual(['Grande', 'Leche de almendras']);
    });

    it('el descuento del admin se aplica sobre el precio con modificadores', async () => {
      const s = await cafeSetup();
      const admin: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN };
      const result = await tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.grande] }]); // 1500

      const sale = await sales.checkout(tenantId, admin, s.table.id, {
        checkoutId: 'checkout-0002',
        paymentMethod: 'efectivo',
        items: [{ orderId: result.orders[0]._id, discount: 10 }],
      });

      expect(sale.totalAmount).toBe(1350);
    });
  });

  describe('cocina', () => {
    it('ve las opciones elegidas en cada línea', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { kitchenEnabled: true } }); // la cocina es opcional
      const s = await cafeSetup();
      await tables.addItems(tenantId, s.table.id, [{ id: s.cafe._id, quantity: 1, modifiers: [s.grande, s.shot] }]);

      const lines = await kitchen.list(tenantId, Role.KITCHEN);

      expect(lines[0].modifiers).toEqual(['Grande', 'Shot extra']);
    });
  });
});
