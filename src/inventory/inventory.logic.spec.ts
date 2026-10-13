import {
  InventoryContext,
  availableStock,
  consumption,
  findShortages,
  maxUnits,
  optionOutOfStock,
  shortageMessage,
  unitCost,
} from './inventory.logic';

// Lógica pura (sin base de datos): consumos, disponibilidad y costos a partir de un contexto armado a mano.
const stock = (id: string, name: string, unit: string, onHand: number, costPerUnit = 0) => ({
  id, name, unit, onHand, minStock: 0, costPerUnit, active: true,
});

function context(): InventoryContext {
  return {
    stock: new Map([
      ['cafe', stock('cafe', 'Café', 'g', 1000, 0.02)],
      ['leche', stock('leche', 'Leche', 'ml', 5000, 0.001)],
      ['almendras', stock('almendras', 'Leche de almendras', 'ml', 2000, 0.003)],
      ['vaso', stock('vaso', 'Vasos', 'unidad', 10, 50)],
      ['gaseosa', stock('gaseosa', 'Gaseosa', 'unidad', 3, 800)],
    ]),
    recipes: new Map([
      ['latte', [{ stockItemId: 'cafe', quantity: 18 }, { stockItemId: 'leche', quantity: 200 }, { stockItemId: 'vaso', quantity: 1 }]],
      ['gaseosa-plato', [{ stockItemId: 'gaseosa', quantity: 1 }]],
    ]),
    optionLines: new Map([
      // Leche de almendras: reemplaza a la leche común
      ['opt-almendras', [{ stockItemId: 'almendras', quantity: 200, replacesStockItemId: 'leche' }]],
      // Shot extra: suma café
      ['opt-shot', [{ stockItemId: 'cafe', quantity: 18, replacesStockItemId: null }]],
      // Sin leche: saca la leche y no consume nada a cambio
      ['opt-sin-leche', [{ stockItemId: 'leche', quantity: 0, replacesStockItemId: 'leche' }]],
    ]),
  };
}

const entries = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort());

describe('inventario: consumo por receta', () => {
  it('una unidad consume lo que dice su receta', () => {
    expect(entries(consumption(context(), 'latte', []))).toEqual({ cafe: 18, leche: 200, vaso: 1 });
  });

  it('un plato sin receta no consume nada', () => {
    expect(entries(consumption(context(), 'sin-receta', []))).toEqual({});
    expect(entries(consumption(context(), null, []))).toEqual({});
  });

  it('una opción que reemplaza saca el insumo original y suma el nuevo', () => {
    expect(entries(consumption(context(), 'latte', ['opt-almendras']))).toEqual({ almendras: 200, cafe: 18, vaso: 1 });
  });

  it('una opción que suma se agrega a lo que ya consumía el plato (shot extra = café x2)', () => {
    expect(entries(consumption(context(), 'latte', ['opt-shot']))).toEqual({ cafe: 36, leche: 200, vaso: 1 });
  });

  it('una opción que solo quita deja ese insumo en cero', () => {
    expect(entries(consumption(context(), 'latte', ['opt-sin-leche']))).toEqual({ cafe: 18, leche: 0, vaso: 1 });
  });

  it('varias opciones se combinan', () => {
    expect(entries(consumption(context(), 'latte', ['opt-almendras', 'opt-shot']))).toEqual({ almendras: 200, cafe: 36, vaso: 1 });
  });
});

describe('inventario: costos', () => {
  it('el costo de una unidad suma insumos x su costo', () => {
    const ctx = context();
    // 18 g x 0,02 + 200 ml x 0,001 + 1 vaso x 50 = 0,36 + 0,2 + 50
    expect(unitCost(ctx, consumption(ctx, 'latte', []))).toBe(50.56);
  });

  it('las opciones cambian el costo (almendras cuesta más que la leche común)', () => {
    const ctx = context();
    // 0,36 + 200 x 0,003 (0,6) + 50
    expect(unitCost(ctx, consumption(ctx, 'latte', ['opt-almendras']))).toBe(50.96);
  });
});

describe('inventario: disponibilidad', () => {
  it('las unidades posibles las limita el insumo más escaso', () => {
    const ctx = context();
    const avail = availableStock(ctx, new Map());

    // café 1000/18 = 55, leche 5000/200 = 25, vasos 10 -> 10
    expect(maxUnits(ctx, avail, 'latte')).toBe(10);
  });

  it('lo ya pedido en mesas abiertas se descuenta de lo disponible', () => {
    const ctx = context();
    const avail = availableStock(ctx, new Map([['vaso', 8]]));

    expect(avail.get('vaso')).toBe(2);
    expect(maxUnits(ctx, avail, 'latte')).toBe(2);
  });

  it('con un insumo en cero, el plato está agotado (0 unidades)', () => {
    const ctx = context();
    const avail = availableStock(ctx, new Map([['vaso', 10]]));

    expect(maxUnits(ctx, avail, 'latte')).toBe(0);
  });

  it('un plato sin receta no se controla (null)', () => {
    const ctx = context();

    expect(maxUnits(ctx, availableStock(ctx, new Map()), 'sin-receta')).toBeNull();
  });

  it('una opción está agotada si falta el insumo que consume', () => {
    const ctx = context();
    expect(optionOutOfStock(ctx, availableStock(ctx, new Map()), 'opt-almendras')).toBe(false);
    expect(optionOutOfStock(ctx, availableStock(ctx, new Map([['almendras', 1900]])), 'opt-almendras')).toBe(true); // quedan 100 ml y necesita 200
  });
});

describe('inventario: faltantes de un pedido', () => {
  it('detecta qué insumo no alcanza, sumando todo lo pedido junto', () => {
    const ctx = context();
    const avail = availableStock(ctx, new Map());

    // 6 gaseosas de a 1: hay 3
    const shortages = findShortages(ctx, avail, [
      { menuItemId: 'gaseosa-plato', quantity: 2, optionIds: [] },
      { menuItemId: 'gaseosa-plato', quantity: 4, optionIds: [] },
    ]);

    expect(shortages).toEqual([{ stockItemId: 'gaseosa', name: 'Gaseosa', unit: 'unidad', needed: 6, available: 3 }]);
    expect(shortageMessage(shortages)).toBe('No hay stock suficiente de Gaseosa: quedan 3 unidad y se necesitan 6');
  });

  it('pedir exactamente lo que hay está permitido', () => {
    const ctx = context();

    expect(findShortages(ctx, availableStock(ctx, new Map()), [{ menuItemId: 'gaseosa-plato', quantity: 3, optionIds: [] }])).toEqual([]);
  });

  it('un plato sin receta nunca falta', () => {
    const ctx = context();

    expect(findShortages(ctx, availableStock(ctx, new Map()), [{ menuItemId: 'sin-receta', quantity: 999, optionIds: [] }])).toEqual([]);
  });
});
