import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { MenuService } from '../menu/menu.service';
import { ModifiersService } from '../modifiers/modifiers.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { Actor, SalesService } from '../sales/sales.service';
import { SettingsService } from '../settings/settings.service';
import { TablesService } from '../tables/tables.service';
import { InventoryService } from './inventory.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Inventario', () => {
  let prisma: PrismaService;
  let inventory: InventoryService;
  let menu: MenuService;
  let modifiers: ModifiersService;
  let tables: TablesService;
  let sales: SalesService;
  let reports: ReportsService;
  let settings: SettingsService;
  let tenantId: string;
  let otherTenantId: string;

  const cashier: Actor = { id: 'c1', name: 'Caro', role: Role.CASHIER };
  const admin: Actor = { id: 'a1', name: 'Ana', role: Role.ADMIN };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    inventory = new InventoryService(prisma);
    menu = new MenuService(prisma);
    modifiers = new ModifiersService(prisma);
    tables = new TablesService(prisma);
    sales = new SalesService(prisma);
    reports = new ReportsService(prisma);
    settings = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'A', plan: 'pro', inventoryEnabled: true, requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B', plan: 'pro', inventoryEnabled: true, requireOpenRegister: false } })).id;
  });

  // ---- datos de prueba ----
  const stock = (name: string, unit: string, onHand: number, cost = 0, min = 0, tid = tenantId) =>
    prisma.stockItem.create({ data: { tenantId: tid, name, unit, onHand, costPerUnit: cost, minStock: min } });

  const dish = async (name: string, price: number, ingredients: [string, number][], tid = tenantId) => {
    const item = await prisma.menuItem.create({ data: { tenantId: tid, name, price } });
    if (ingredients.length) {
      await prisma.menuItemIngredient.createMany({ data: ingredients.map(([stockItemId, quantity]) => ({ menuItemId: item.id, stockItemId, quantity })) });
    }
    return item;
  };

  const newTable = (name = 'Mesa 1', tid = tenantId) => prisma.table.create({ data: { tenantId: tid, name, available: false } });

  // Latte: 18 g de café + 200 ml de leche + 1 vaso. Café $20/kg, leche $1/l, vaso $50.
  async function lattePack() {
    const cafe = await stock('Café', 'g', 1000, 0.02);
    const leche = await stock('Leche', 'ml', 5000, 0.001);
    const vaso = await stock('Vasos', 'unidad', 10, 50);
    const latte = await dish('Latte', 4500, [[cafe.id, 18], [leche.id, 200], [vaso.id, 1]]);
    return { cafe, leche, vaso, latte };
  }

  const onHand = async (id: string) => (await prisma.stockItem.findUniqueOrThrow({ where: { id } })).onHand;

  // =====================================================================
  describe('insumos', () => {
    it('crea un insumo con unidad, mínimo y costo, y el stock inicial queda en el libro', async () => {
      const item = await inventory.createItem(tenantId, 'Ana', { name: 'Café', unit: 'g', minStock: 200, costPerUnit: 0.02, initialQuantity: 1000 });

      expect(item).toMatchObject({ name: 'Café', unit: 'g', onHand: 1000, minStock: 200, costPerUnit: 0.02, status: 'ok' });
      const moves = await inventory.movements(tenantId, {});
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ type: 'ADJUSTMENT', quantity: 1000, balanceAfter: 1000, note: 'Stock inicial', createdBy: 'Ana' });
    });

    it('valida nombre, unidad, repetidos y números', async () => {
      await expect(inventory.createItem(tenantId, 'Ana', { name: '   ' })).rejects.toThrow(BadRequestException);
      await expect(inventory.createItem(tenantId, 'Ana', { name: 'X', unit: 'docena' })).rejects.toThrow(/Unidad no válida/);
      await expect(inventory.createItem(tenantId, 'Ana', { name: 'X', minStock: -1 })).rejects.toThrow(BadRequestException);
      await inventory.createItem(tenantId, 'Ana', { name: 'Café' });
      await expect(inventory.createItem(tenantId, 'Ana', { name: ' cafe ' })).rejects.toThrow(ConflictException); // sin tildes ni mayúsculas
      await expect(inventory.createItem(otherTenantId, 'Ana', { name: 'Café' })).resolves.toBeDefined(); // otro negocio: ok
    });

    it('el estado sale del stock: agotado, bajo (en o por debajo del mínimo) u ok', async () => {
      await stock('Agotado', 'unidad', 0, 0, 5);
      await stock('Negativo', 'unidad', -2, 0, 5);
      await stock('Bajo', 'unidad', 5, 0, 5);
      await stock('Normal', 'unidad', 6, 0, 5);
      await stock('Sin mínimo', 'unidad', 1, 0, 0);

      const items = await inventory.listItems(tenantId);
      const status = Object.fromEntries(items.map((i) => [i.name, i.status]));

      expect(status).toEqual({ Agotado: 'out', Negativo: 'out', Bajo: 'low', Normal: 'ok', 'Sin mínimo': 'ok' });
      expect(await inventory.summary(tenantId)).toEqual({ itemsCount: 5, lowCount: 1, outCount: 2 });
    });

    it('no deja cambiar la unidad de medida (rompería las recetas)', async () => {
      const item = await stock('Café', 'g', 100);

      await expect(inventory.updateItem(tenantId, item.id, { unit: 'kg' })).rejects.toThrow(/no se puede cambiar/);
      expect((await inventory.updateItem(tenantId, item.id, { name: 'Café en grano', minStock: 50, costPerUnit: 0.03 })).name).toBe('Café en grano');
    });

    it('un insumo usado en una receta no se borra; uno libre sí', async () => {
      const { cafe } = await lattePack();
      const libre = await stock('Servilletas', 'unidad', 100);

      await expect(inventory.removeItem(tenantId, cafe.id)).rejects.toThrow(/Se usa en 1 receta/);
      await expect(inventory.removeItem(tenantId, libre.id)).resolves.toBeDefined();
      expect(await prisma.stockItem.findUnique({ where: { id: libre.id } })).toBeNull();
    });
  });

  // =====================================================================
  describe('entradas, mermas, ajustes y conteo', () => {
    it('una compra suma stock y promedia el costo con lo que ya había', async () => {
      const item = await stock('Café', 'g', 1000, 0.02); // 1000 g a $0,02

      // entran 1000 g a $0,04 -> promedio ponderado $0,03
      const updated = await inventory.purchase(tenantId, 'Ana', item.id, { quantity: 1000, unitCost: 0.04, supplier: 'Tostadero Sur', note: 'Factura 123' });

      expect(updated).toMatchObject({ onHand: 2000, costPerUnit: 0.03 });
      const [move] = await inventory.movements(tenantId, { stockItemId: item.id });
      expect(move).toMatchObject({ type: 'PURCHASE', quantity: 1000, balanceAfter: 2000, unitCost: 0.04, supplier: 'Tostadero Sur', note: 'Factura 123' });
    });

    it('con stock en cero, el costo de la compra pasa a ser el costo del insumo', async () => {
      const item = await stock('Leche', 'ml', 0, 0.5);

      const updated = await inventory.purchase(tenantId, 'Ana', item.id, { quantity: 2000, unitCost: 0.002 });

      expect(updated.costPerUnit).toBe(0.002);
    });

    it('una compra sin costo no cambia el costo', async () => {
      const item = await stock('Vasos', 'unidad', 10, 50);

      expect((await inventory.purchase(tenantId, 'Ana', item.id, { quantity: 90 })).costPerUnit).toBe(50);
    });

    it('valida cantidades de compra', async () => {
      const item = await stock('Vasos', 'unidad', 10);

      await expect(inventory.purchase(tenantId, 'Ana', item.id, { quantity: 0 })).rejects.toThrow(BadRequestException);
      await expect(inventory.purchase(tenantId, 'Ana', item.id, { quantity: -5 })).rejects.toThrow(BadRequestException);
      await expect(inventory.purchase(tenantId, 'Ana', item.id, { quantity: 5, unitCost: -1 })).rejects.toThrow(BadRequestException);
    });

    it('una merma resta, exige motivo y no puede superar el stock', async () => {
      const item = await stock('Leche', 'ml', 1000);

      await expect(inventory.waste(tenantId, 'Ana', item.id, { quantity: 100, reason: '  ' })).rejects.toThrow(/motivo/);
      await expect(inventory.waste(tenantId, 'Ana', item.id, { quantity: 5000, reason: 'Se venció' })).rejects.toThrow(/No podés dar de baja/);

      const updated = await inventory.waste(tenantId, 'Ana', item.id, { quantity: 250, reason: 'Se venció' });

      expect(updated.onHand).toBe(750);
      const [move] = await inventory.movements(tenantId, {});
      expect(move).toMatchObject({ type: 'WASTE', quantity: -250, balanceAfter: 750, note: 'Se venció' });
    });

    it('un ajuste deja el stock en lo contado y registra la diferencia', async () => {
      const item = await stock('Vasos', 'unidad', 10);

      const updated = await inventory.adjust(tenantId, 'Ana', item.id, { counted: 7, note: 'Faltaban 3' });

      expect(updated.onHand).toBe(7);
      expect((await inventory.movements(tenantId, {}))[0]).toMatchObject({ type: 'ADJUSTMENT', quantity: -3, balanceAfter: 7 });
      // ajustar a lo mismo no genera movimiento
      await inventory.adjust(tenantId, 'Ana', item.id, { counted: 7 });
      expect(await prisma.stockMovement.count({ where: { stockItemId: item.id } })).toBe(1);
    });

    it('el conteo físico ajusta solo las diferencias y las valúa al costo', async () => {
      const cafe = await stock('Café', 'g', 1000, 0.02);
      const leche = await stock('Leche', 'ml', 5000, 0.001);
      const vasos = await stock('Vasos', 'unidad', 10, 50);

      const result = await inventory.count(tenantId, 'Ana', {
        counts: [
          { stockItemId: cafe.id, counted: 950 }, // faltan 50 g = $1
          { stockItemId: leche.id, counted: 5000 }, // justo
          { stockItemId: vasos.id, counted: 12 }, // sobran 2 = $100
        ],
        note: 'Cierre del mes',
      });

      expect(result.differences).toBe(2);
      expect(result.totalValue).toBe(99); // -1 + 100
      expect(result.items.find((i) => i.name === 'Café')).toMatchObject({ expected: 1000, counted: 950, difference: -50, value: -1 });
      expect(await onHand(cafe.id)).toBe(950);
      expect(await onHand(leche.id)).toBe(5000);
      expect(await onHand(vasos.id)).toBe(12);
      // la leche, sin diferencia, no tiene movimiento
      expect(await prisma.stockMovement.count({ where: { stockItemId: leche.id } })).toBe(0);
      expect((await inventory.movements(tenantId, { stockItemId: cafe.id }))[0].note).toBe('Cierre del mes');
    });

    it('un conteo con un insumo repetido o ajeno se rechaza entero y no cambia nada', async () => {
      const cafe = await stock('Café', 'g', 1000);
      const ajeno = await stock('Ajeno', 'g', 10, 0, 0, otherTenantId);

      await expect(inventory.count(tenantId, 'Ana', { counts: [{ stockItemId: cafe.id, counted: 1 }, { stockItemId: cafe.id, counted: 2 }] })).rejects.toThrow(/repetido/);
      await expect(inventory.count(tenantId, 'Ana', { counts: [{ stockItemId: cafe.id, counted: 1 }, { stockItemId: ajeno.id, counted: 2 }] })).rejects.toThrow(NotFoundException);
      expect(await onHand(cafe.id)).toBe(1000); // la transacción se deshizo
    });

    it('el libro lista lo más reciente primero y se puede filtrar por insumo', async () => {
      const a = await stock('A', 'unidad', 10);
      const b = await stock('B', 'unidad', 10);
      await inventory.purchase(tenantId, 'Ana', a.id, { quantity: 1 });
      await inventory.purchase(tenantId, 'Ana', b.id, { quantity: 2 });
      await inventory.waste(tenantId, 'Ana', a.id, { quantity: 1, reason: 'Roto' });

      expect((await inventory.movements(tenantId, {})).map((m) => [m.name, m.type])).toEqual([['A', 'WASTE'], ['B', 'PURCHASE'], ['A', 'PURCHASE']]);
      expect(await inventory.movements(tenantId, { stockItemId: b.id })).toHaveLength(1);
    });

    it('las operaciones simultáneas sobre un mismo insumo no se pisan (dos mermas a la vez)', async () => {
      const item = await stock('Vasos', 'unidad', 10);

      await Promise.all([
        inventory.waste(tenantId, 'Ana', item.id, { quantity: 3, reason: 'Roto' }),
        inventory.waste(tenantId, 'Ana', item.id, { quantity: 4, reason: 'Roto' }),
      ]);

      expect(await onHand(item.id)).toBe(3); // 10 - 3 - 4, sin perder ninguna
    });
  });

  // =====================================================================
  describe('recetas y costos', () => {
    it('arma la receta de un plato y calcula costo y margen', async () => {
      const cafe = await stock('Café', 'g', 1000, 0.02);
      const leche = await stock('Leche', 'ml', 5000, 0.001);
      const vaso = await stock('Vasos', 'unidad', 10, 50);
      const latte = await prisma.menuItem.create({ data: { tenantId, name: 'Latte', price: 4500 } });

      const recipe = await inventory.setRecipe(tenantId, latte.id, [
        { stockItemId: cafe.id, quantity: 18 },
        { stockItemId: leche.id, quantity: 200 },
        { stockItemId: vaso.id, quantity: 1 },
      ]);

      expect(recipe).toMatchObject({ name: 'Latte', price: 4500, cost: 50.56, margin: 4449.44 });
      expect(recipe?.marginPct).toBeCloseTo(98.88, 2);
      expect(recipe?.ingredients.map((i) => [i.name, i.quantity, i.unit])).toEqual([['Café', 18, 'g'], ['Leche', 200, 'ml'], ['Vasos', 1, 'unidad']]);
    });

    it('un plato sin receta no tiene costo ni margen', async () => {
      await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 1000 } });

      const [row] = await inventory.recipes(tenantId);

      expect(row).toMatchObject({ ingredients: [], cost: null, margin: null, marginPct: null });
    });

    it('guardar una receta reemplaza la anterior, y una lista vacía la borra', async () => {
      const { cafe, latte } = await lattePack();

      await inventory.setRecipe(tenantId, latte.id, [{ stockItemId: cafe.id, quantity: 20 }]);
      expect((await inventory.recipes(tenantId))[0].ingredients).toHaveLength(1);

      await inventory.setRecipe(tenantId, latte.id, []);
      expect((await inventory.recipes(tenantId))[0].ingredients).toHaveLength(0);
    });

    it('valida la receta: cantidades, insumos repetidos y de otro negocio', async () => {
      const cafe = await stock('Café', 'g', 1000);
      const ajeno = await stock('Ajeno', 'g', 10, 0, 0, otherTenantId);
      const latte = await prisma.menuItem.create({ data: { tenantId, name: 'Latte', price: 1 } });

      await expect(inventory.setRecipe(tenantId, latte.id, [{ stockItemId: cafe.id, quantity: 0 }])).rejects.toThrow(BadRequestException);
      await expect(inventory.setRecipe(tenantId, latte.id, [{ stockItemId: cafe.id, quantity: 1 }, { stockItemId: cafe.id, quantity: 2 }])).rejects.toThrow(ConflictException);
      await expect(inventory.setRecipe(tenantId, latte.id, [{ stockItemId: ajeno.id, quantity: 1 }])).rejects.toThrow(NotFoundException);
    });

    it('las opciones consumen insumos: reemplazan o suman, con su propio costo', async () => {
      const { leche } = await lattePack();
      const almendras = await stock('Leche de almendras', 'ml', 2000, 0.003);
      const group = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Almendras', priceDelta: 300 }] });
      const optionId = group.options[0]._id;

      const result = await inventory.setOptionIngredients(tenantId, optionId, [{ stockItemId: almendras.id, quantity: 200, replacesStockItemId: leche.id }]);

      expect(result?.ingredients).toEqual([{ stockItemId: almendras.id, name: 'Leche de almendras', unit: 'ml', quantity: 200, replacesStockItemId: leche.id }]);
      expect((await inventory.options(tenantId))[0]).toMatchObject({ groupName: 'Leche', name: 'Almendras' });
    });

    it('una opción de otro negocio o con insumos ajenos se rechaza', async () => {
      const grupoAjeno = await modifiers.create(otherTenantId, { name: 'Ajeno', options: [{ name: 'x' }] });
      const mio = await stock('Mío', 'ml', 1);
      const grupo = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'a' }] });
      const insumoAjeno = await stock('Ajeno', 'ml', 1, 0, 0, otherTenantId);

      await expect(inventory.setOptionIngredients(tenantId, grupoAjeno.options[0]._id, [{ stockItemId: mio.id, quantity: 1 }])).rejects.toThrow(NotFoundException);
      await expect(inventory.setOptionIngredients(tenantId, grupo.options[0]._id, [{ stockItemId: insumoAjeno.id, quantity: 1 }])).rejects.toThrow(NotFoundException);
      await expect(inventory.setOptionIngredients(tenantId, grupo.options[0]._id, [{ stockItemId: mio.id, quantity: 1, replacesStockItemId: insumoAjeno.id }])).rejects.toThrow(NotFoundException);
    });
  });

  // =====================================================================
  describe('disponibilidad en el menú', () => {
    it('cada plato con receta informa cuántas unidades se pueden preparar; sin receta, null', async () => {
      const { latte } = await lattePack(); // el limitante son los vasos: 10
      const combo = await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 1 } });

      const items = await menu.findAll(tenantId);

      expect(items.find((i) => i._id === latte.id)?.availableUnits).toBe(10);
      expect(items.find((i) => i._id === combo.id)?.availableUnits).toBeNull();
    });

    it('lo pedido en mesas abiertas ya cuenta: el mozo ve lo que realmente queda', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();

      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 8 }]);

      expect((await menu.findAll(tenantId)).find((i) => i._id === latte.id)?.availableUnits).toBe(2);
    });

    it('con el inventario apagado no hay control (null en todo)', async () => {
      const { latte } = await lattePack();
      await prisma.tenant.update({ where: { id: tenantId }, data: { inventoryEnabled: false } });

      expect((await menu.findAll(tenantId)).find((i) => i._id === latte.id)?.availableUnits).toBeNull();
    });

    it('una opción cuyo insumo se agotó se marca "outOfStock"', async () => {
      const almendras = await stock('Leche de almendras', 'ml', 100); // alcanza para 0 porciones de 200
      const group = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Almendras' }, { name: 'Entera' }] });
      await inventory.setOptionIngredients(tenantId, group.options[0]._id, [{ stockItemId: almendras.id, quantity: 200 }]);

      const [g] = await modifiers.findAll(tenantId);

      expect(g.options.map((o) => [o.name, o.outOfStock])).toEqual([['Almendras', true], ['Entera', false]]);
    });
  });

  // =====================================================================
  describe('pedir con stock', () => {
    it('no deja pedir más de lo que alcanza, y no crea nada', async () => {
      const { latte } = await lattePack(); // 10 vasos
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 11 }])).rejects.toThrow(/No hay stock suficiente de Vasos: quedan 10 unidad y se necesitan 11/);
      expect(await prisma.order.count({ where: { tableId: mesa.id } })).toBe(0);
    });

    it('descuenta de lo disponible lo ya pedido en otras mesas', async () => {
      const { latte } = await lattePack();
      const a = await newTable('A');
      const b = await newTable('B');

      await tables.addItems(tenantId, a.id, [{ id: latte.id, quantity: 8 }]);

      await expect(tables.addItems(tenantId, b.id, [{ id: latte.id, quantity: 3 }])).rejects.toThrow(ConflictException);
      await expect(tables.addItems(tenantId, b.id, [{ id: latte.id, quantity: 2 }])).resolves.toBeDefined(); // justo lo que queda
    });

    it('suma todo lo pedido junto: dos líneas que comparten insumo', async () => {
      const vaso = await stock('Vasos', 'unidad', 5);
      const a = await dish('Té', 1000, [[vaso.id, 1]]);
      const b = await dish('Café', 1000, [[vaso.id, 1]]);
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: a.id, quantity: 3 }, { id: b.id, quantity: 3 }])).rejects.toThrow(/quedan 5 unidad y se necesitan 6/);
    });

    it('subir la cantidad de una orden también comprueba el stock de la diferencia', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();
      const result = await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 4 }]);
      const orderId = result.orders[0]._id;

      await expect(tables.updateOrderQuantities(tenantId, mesa.id, [{ orderId, quantity: 11 }])).rejects.toThrow(ConflictException);
      await expect(tables.updateOrderQuantities(tenantId, mesa.id, [{ orderId, quantity: 10 }])).resolves.toBeDefined();
      // bajar nunca se bloquea
      await expect(tables.updateOrderQuantities(tenantId, mesa.id, [{ orderId, quantity: 1 }])).resolves.toBeDefined();
    });

    it('si falta el insumo de una opción (leche de almendras), no se puede pedir con esa opción', async () => {
      const { latte, leche } = await lattePack();
      const almendras = await stock('Leche de almendras', 'ml', 100);
      const group = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Almendras' }] });
      const optionId = group.options[0]._id;
      await inventory.setOptionIngredients(tenantId, optionId, [{ stockItemId: almendras.id, quantity: 200, replacesStockItemId: leche.id }]);
      await menu.update(tenantId, latte.id, { modifierGroupIds: [group._id] });
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1, modifiers: [optionId] }])).rejects.toThrow(/Leche de almendras/);
      // sin la opción, el latte se puede pedir
      await expect(tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }])).resolves.toBeDefined();
    });

    it('si el negocio no bloquea, deja pedir igual (solo informa)', async () => {
      const { latte } = await lattePack();
      await prisma.tenant.update({ where: { id: tenantId }, data: { blockOutOfStock: false } });
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 50 }])).resolves.toBeDefined();
    });

    it('con el inventario apagado no se controla nada', async () => {
      const { latte } = await lattePack();
      await prisma.tenant.update({ where: { id: tenantId }, data: { inventoryEnabled: false } });
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 50 }])).resolves.toBeDefined();
    });

    it('un plato sin receta no se controla aunque haya inventario', async () => {
      await lattePack();
      const combo = await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 1000 } });
      const mesa = await newTable();

      await expect(tables.addItems(tenantId, mesa.id, [{ id: combo.id, quantity: 500 }])).resolves.toBeDefined();
    });

    it('dos mozos pidiendo a la vez la última unidad: solo uno se la lleva', async () => {
      const vaso = await stock('Vasos', 'unidad', 1);
      const cafe = await dish('Café', 1000, [[vaso.id, 1]]);
      const a = await newTable('A');
      const b = await newTable('B');

      const results = await Promise.allSettled([
        tables.addItems(tenantId, a.id, [{ id: cafe.id, quantity: 1 }]),
        tables.addItems(tenantId, b.id, [{ id: cafe.id, quantity: 1 }]),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await prisma.order.count({ where: { table: { tenantId } } })).toBe(1);
    });
  });

  // =====================================================================
  describe('cobrar descuenta el stock', () => {
    it('al cobrar se descuentan los insumos y queda el movimiento de venta', async () => {
      const { cafe, leche, vaso, latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 2 }]);

      // pedir NO descuenta lo físico: eso pasa al cobrar
      expect(await onHand(vaso.id)).toBe(10);

      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0001', paymentMethod: 'efectivo' });

      expect(await onHand(cafe.id)).toBe(964); // 1000 - 36
      expect(await onHand(leche.id)).toBe(4600); // 5000 - 400
      expect(await onHand(vaso.id)).toBe(8);
      const moves = await prisma.stockMovement.findMany({ where: { reference: sale._id } });
      expect(moves.map((m) => m.quantity).sort((a, b) => a - b)).toEqual([-400, -36, -2]); // leche, café, vasos
      expect(moves.every((m) => m.type === 'SALE' && m.createdBy === 'Caro' && m.reference === sale._id)).toBe(true);
    });

    it('al cobrar se libera lo "comprometido": la disponibilidad se recalcula con el stock real', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 8 }]);
      expect((await menu.findAll(tenantId)).find((i) => i._id === latte.id)?.availableUnits).toBe(2);

      await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0002', paymentMethod: 'efectivo' });

      // ya no hay órdenes abiertas, y el stock físico bajó a 2 vasos: sigue siendo 2 (no 10 ni -6)
      expect((await menu.findAll(tenantId)).find((i) => i._id === latte.id)?.availableUnits).toBe(2);
    });

    it('guarda el costo de cada línea al momento de la venta', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);

      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0003', paymentMethod: 'efectivo' });

      const item = await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale._id } });
      expect(item.unitCost).toBe(50.56);
    });

    it('un cambio de costo posterior no altera el costo de las ventas ya hechas', async () => {
      const { cafe, latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);
      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0004', paymentMethod: 'efectivo' });

      await inventory.updateItem(tenantId, cafe.id, { costPerUnit: 1 }); // el café se disparó

      expect((await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale._id } })).unitCost).toBe(50.56);
    });

    it('una opción que reemplaza consume su insumo y no el original; el costo la refleja', async () => {
      const { cafe, leche, vaso, latte } = await lattePack();
      const almendras = await stock('Leche de almendras', 'ml', 2000, 0.003);
      const group = await modifiers.create(tenantId, { name: 'Leche', options: [{ name: 'Almendras', priceDelta: 300 }] });
      const optionId = group.options[0]._id;
      await inventory.setOptionIngredients(tenantId, optionId, [{ stockItemId: almendras.id, quantity: 200, replacesStockItemId: leche.id }]);
      await menu.update(tenantId, latte.id, { modifierGroupIds: [group._id] });
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 2, modifiers: [optionId] }]);

      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0005', paymentMethod: 'efectivo' });

      expect(await onHand(almendras.id)).toBe(1600); // 2 x 200
      expect(await onHand(leche.id)).toBe(5000); // la común no se tocó
      expect(await onHand(cafe.id)).toBe(964);
      expect(await onHand(vaso.id)).toBe(8);
      // 18 g x 0,02 + 200 ml x 0,003 + vaso 50 = 50,96
      expect((await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale._id } })).unitCost).toBe(50.96);
    });

    it('un cobro parcial descuenta solo lo cobrado', async () => {
      const { vaso, latte } = await lattePack();
      const mesa = await newTable();
      const added = await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 3 }]);

      await sales.checkout(tenantId, cashier, mesa.id, {
        checkoutId: 'checkout-0006',
        paymentMethod: 'efectivo',
        lines: [{ orderId: added.orders[0]._id, quantity: 1 }],
      });

      expect(await onHand(vaso.id)).toBe(9); // solo 1 cobrado; los otros 2 siguen "comprometidos" en la mesa
      expect((await menu.findAll(tenantId)).find((i) => i._id === latte.id)?.availableUnits).toBe(7); // 9 - 2 pendientes
    });

    it('un reintento del mismo cobro no descuenta dos veces', async () => {
      const { vaso, latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);
      const input = { checkoutId: 'checkout-0007', paymentMethod: 'efectivo' };

      await sales.checkout(tenantId, cashier, mesa.id, input);
      await sales.checkout(tenantId, cashier, mesa.id, input);

      expect(await onHand(vaso.id)).toBe(9);
      expect(await prisma.stockMovement.count({ where: { type: 'SALE', stockItem: { name: 'Vasos' } } })).toBe(1);
    });

    it('si el cobro falla, el stock no se toca', async () => {
      const { vaso, latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);

      await expect(sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0008', payments: [{ method: 'efectivo', amount: 1 }] })).rejects.toThrow(BadRequestException);

      expect(await onHand(vaso.id)).toBe(10);
      expect(await prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(0);
    });

    it('con el inventario apagado el cobro no toca stock ni guarda costo', async () => {
      const { vaso, latte } = await lattePack();
      await prisma.tenant.update({ where: { id: tenantId }, data: { inventoryEnabled: false } });
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);

      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0009', paymentMethod: 'efectivo' });

      expect(await onHand(vaso.id)).toBe(10);
      expect((await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale._id } })).unitCost).toBeNull();
    });

    it('un plato sin receta se cobra normal: sin descuento y sin costo', async () => {
      await lattePack();
      const combo = await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 1000 } });
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: combo.id, quantity: 1 }]);

      const sale = await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0010', paymentMethod: 'efectivo' });

      expect((await prisma.saleItem.findFirstOrThrow({ where: { saleId: sale._id } })).unitCost).toBeNull();
      expect(await prisma.stockMovement.count({ where: { type: 'SALE' } })).toBe(0);
    });

    it('vender sin stock (si no se bloqueaba) deja el insumo en negativo y lo marca agotado', async () => {
      const vaso = await stock('Vasos', 'unidad', 1);
      const cafe = await dish('Café', 1000, [[vaso.id, 1]]);
      await prisma.tenant.update({ where: { id: tenantId }, data: { blockOutOfStock: false } });
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: cafe.id, quantity: 3 }]);

      await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0011', paymentMethod: 'efectivo' });

      expect(await onHand(vaso.id)).toBe(-2);
      expect((await inventory.listItems(tenantId))[0].status).toBe('out');
    });
  });

  // =====================================================================
  describe('ganancia en los reportes', () => {
    it('calcula costo, ganancia y margen de lo vendido con receta', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 2 }]); // 2 x 4500 = 9000, costo 2 x 50,56
      await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0012', paymentMethod: 'efectivo' });

      const r = await reports.sales(tenantId, { tz: 'UTC' });

      expect(r.summary).toMatchObject({ totalAmount: 9000, costTotal: 101.12, profit: 8898.88, revenueWithoutCost: 0 });
      expect(r.summary.profitMarginPct).toBeCloseTo(98.88, 2);
      expect(r.items[0]).toMatchObject({ name: 'Latte', quantity: 2, amount: 9000, cost: 101.12, profit: 8898.88 });
    });

    it('lo vendido sin receta no entra en la ganancia: se informa aparte', async () => {
      const { latte } = await lattePack();
      const combo = await prisma.menuItem.create({ data: { tenantId, name: 'Combo', price: 1000 } });
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }, { id: combo.id, quantity: 1 }]);
      await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0013', paymentMethod: 'efectivo' });

      const r = await reports.sales(tenantId, { tz: 'UTC' });

      expect(r.summary).toMatchObject({ totalAmount: 5500, costTotal: 50.56, revenueWithoutCost: 1000 });
      expect(r.summary.profit).toBe(4449.44); // solo sobre el latte
      expect(r.items.find((i) => i.name === 'Combo')).toMatchObject({ cost: null, profit: null });
    });

    it('el descuento del admin baja la ganancia (se vendió más barato al mismo costo)', async () => {
      const { latte } = await lattePack();
      const mesa = await newTable();
      const added = await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);
      await sales.checkout(tenantId, admin, mesa.id, {
        checkoutId: 'checkout-0014', paymentMethod: 'efectivo', items: [{ orderId: added.orders[0]._id, discount: 50 }],
      });

      const r = await reports.sales(tenantId, { tz: 'UTC' });

      expect(r.summary.profit).toBe(2199.44); // 2250 - 50,56
    });
  });

  // =====================================================================
  describe('ajustes del negocio', () => {
    it('el inventario solo se puede activar si el plan lo incluye', async () => {
      const basic = (await prisma.tenant.create({ data: { name: 'Básico', plan: 'basic' } })).id;

      await expect(settings.update(basic, { inventoryEnabled: true })).rejects.toThrow(/no incluye/);

      const s = await settings.update(tenantId, { inventoryEnabled: true, blockOutOfStock: false });
      expect(s).toMatchObject({ inventoryEnabled: true, inventoryActive: true, blockOutOfStock: false });
    });

    it('si el plan baja, el inventario deja de regir aunque haya quedado activado', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { plan: 'basic' } });

      expect(await settings.get(tenantId)).toMatchObject({ inventoryEnabled: true, inventoryActive: false });
    });
  });

  // =====================================================================
  describe('aislamiento entre negocios', () => {
    it('no se ven, tocan ni consumen insumos de otro negocio', async () => {
      const ajeno = await stock('Ajeno', 'g', 100, 0, 0, otherTenantId);

      expect((await inventory.listItems(tenantId)).map((i) => i.name)).not.toContain('Ajeno');
      await expect(inventory.purchase(tenantId, 'Ana', ajeno.id, { quantity: 1 })).rejects.toThrow(NotFoundException);
      await expect(inventory.waste(tenantId, 'Ana', ajeno.id, { quantity: 1, reason: 'x' })).rejects.toThrow(NotFoundException);
      await expect(inventory.updateItem(tenantId, ajeno.id, { name: 'Hackeado' })).rejects.toThrow(NotFoundException);
      await expect(inventory.removeItem(tenantId, ajeno.id)).rejects.toThrow(NotFoundException);
      expect(await onHand(ajeno.id)).toBe(100);
      expect(await inventory.movements(tenantId, { stockItemId: ajeno.id })).toEqual([]);
    });

    it('las ventas de un negocio no descuentan el stock de otro', async () => {
      const { latte, vaso } = await lattePack();
      const vasoAjeno = await stock('Vasos', 'unidad', 10, 50, 0, otherTenantId);
      const mesa = await newTable();
      await tables.addItems(tenantId, mesa.id, [{ id: latte.id, quantity: 1 }]);

      await sales.checkout(tenantId, cashier, mesa.id, { checkoutId: 'checkout-0015', paymentMethod: 'efectivo' });

      expect(await onHand(vaso.id)).toBe(9);
      expect(await onHand(vasoAjeno.id)).toBe(10);
    });
  });
});
