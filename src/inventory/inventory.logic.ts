import { Prisma, PrismaClient } from '@prisma/client';
import { readSnapshot } from '../modifiers/modifiers.logic';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Ingredient {
  stockItemId: string;
  quantity: number;
}

export interface OptionLine extends Ingredient {
  replacesStockItemId: string | null;
}

export interface StockInfo {
  id: string;
  name: string;
  unit: string;
  onHand: number;
  minStock: number;
  costPerUnit: number;
  active: boolean;
}

// Todo lo necesario para calcular consumos y costos de un negocio, leído de una sola vez
export interface InventoryContext {
  stock: Map<string, StockInfo>;
  recipes: Map<string, Ingredient[]>; // menuItemId -> insumos de UNA unidad
  optionLines: Map<string, OptionLine[]>; // optionId -> insumos que consume esa opción
}

export const UNITS = ['unidad', 'g', 'kg', 'ml', 'l'] as const;

const EPS = 1e-9;
export const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function loadContext(db: Db, tenantId: string): Promise<InventoryContext> {
  const [items, recipeRows, optionRows] = await Promise.all([
    db.stockItem.findMany({ where: { tenantId } }),
    db.menuItemIngredient.findMany({ where: { menuItem: { tenantId } } }),
    db.modifierOptionIngredient.findMany({ where: { option: { group: { tenantId } } } }),
  ]);

  const recipes = new Map<string, Ingredient[]>();
  for (const r of recipeRows) {
    const list = recipes.get(r.menuItemId) ?? [];
    list.push({ stockItemId: r.stockItemId, quantity: r.quantity });
    recipes.set(r.menuItemId, list);
  }
  const optionLines = new Map<string, OptionLine[]>();
  for (const r of optionRows) {
    const list = optionLines.get(r.optionId) ?? [];
    list.push({ stockItemId: r.stockItemId, quantity: r.quantity, replacesStockItemId: r.replacesStockItemId });
    optionLines.set(r.optionId, list);
  }
  return { stock: new Map(items.map((i) => [i.id, i])), recipes, optionLines };
}

/**
 * Lo que consume UNA unidad de un plato con las opciones elegidas: la receta, más lo que suma cada
 * opción; una opción que "reemplaza" un insumo (ej: leche de almendras por leche común) lo saca de la receta.
 */
export function consumption(ctx: InventoryContext, menuItemId: string | null, optionIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ing of (menuItemId && ctx.recipes.get(menuItemId)) || []) out.set(ing.stockItemId, ing.quantity);
  for (const optionId of optionIds) {
    for (const line of ctx.optionLines.get(optionId) ?? []) {
      if (line.replacesStockItemId) out.delete(line.replacesStockItemId);
      out.set(line.stockItemId, (out.get(line.stockItemId) ?? 0) + line.quantity);
    }
  }
  return out;
}

export const optionIdsOf = (modifiers: unknown): string[] => readSnapshot(modifiers).map((m) => m.optionId);

export const hasRecipe = (ctx: InventoryContext, menuItemId: string | null) =>
  !!menuItemId && (ctx.recipes.get(menuItemId)?.length ?? 0) > 0;

// Costo de una unidad: insumos consumidos x su costo
export function unitCost(ctx: InventoryContext, consumed: Map<string, number>): number {
  let total = 0;
  for (const [stockId, qty] of consumed) total += qty * (ctx.stock.get(stockId)?.costPerUnit ?? 0);
  return round4(total);
}

/** Lo ya pedido en mesas abiertas (todavía no cobrado): está "comprometido" aunque no se haya descontado. */
export async function committedConsumption(db: Db, tenantId: string, ctx: InventoryContext): Promise<Map<string, number>> {
  const orders = await db.order.findMany({
    where: { table: { tenantId }, menuItemId: { not: null } },
    select: { menuItemId: true, quantity: true, modifiers: true },
  });
  const committed = new Map<string, number>();
  for (const o of orders) {
    for (const [stockId, qty] of consumption(ctx, o.menuItemId, optionIdsOf(o.modifiers))) {
      committed.set(stockId, (committed.get(stockId) ?? 0) + qty * o.quantity);
    }
  }
  return committed;
}

// Disponible para pedir = existencias - lo ya pedido y sin cobrar
export function availableStock(ctx: InventoryContext, committed: Map<string, number>): Map<string, number> {
  const avail = new Map<string, number>();
  for (const [id, item] of ctx.stock) avail.set(id, round4(item.onHand - (committed.get(id) ?? 0)));
  return avail;
}

/** Cuántas unidades de un plato se pueden preparar con lo disponible. null = sin receta (no se controla). */
export function maxUnits(ctx: InventoryContext, avail: Map<string, number>, menuItemId: string): number | null {
  const ingredients = ctx.recipes.get(menuItemId);
  if (!ingredients?.length) return null;
  let units = Infinity;
  for (const ing of ingredients) {
    if (ing.quantity <= 0) continue;
    units = Math.min(units, Math.floor((avail.get(ing.stockItemId) ?? 0) / ing.quantity + EPS));
  }
  return Number.isFinite(units) ? Math.max(0, units) : null;
}

// Una opción está agotada si falta alguno de los insumos que consume
export function optionOutOfStock(ctx: InventoryContext, avail: Map<string, number>, optionId: string): boolean {
  return (ctx.optionLines.get(optionId) ?? []).some((l) => (avail.get(l.stockItemId) ?? 0) + EPS < l.quantity);
}

export interface StockRequest {
  menuItemId: string;
  quantity: number;
  optionIds: string[];
}

export interface Shortage {
  stockItemId: string;
  name: string;
  unit: string;
  needed: number;
  available: number;
}

/** Qué insumos no alcanzan para preparar lo pedido (suma todo lo pedido junto). */
export function findShortages(ctx: InventoryContext, avail: Map<string, number>, requests: StockRequest[]): Shortage[] {
  const needed = new Map<string, number>();
  for (const r of requests) {
    for (const [stockId, qty] of consumption(ctx, r.menuItemId, r.optionIds)) {
      needed.set(stockId, (needed.get(stockId) ?? 0) + qty * r.quantity);
    }
  }
  const shortages: Shortage[] = [];
  for (const [stockId, need] of needed) {
    const have = avail.get(stockId) ?? 0;
    if (need > have + EPS) {
      const item = ctx.stock.get(stockId);
      shortages.push({ stockItemId: stockId, name: item?.name ?? 'insumo', unit: item?.unit ?? '', needed: round4(need), available: Math.max(0, round4(have)) });
    }
  }
  return shortages;
}

export const formatQty = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

export function shortageMessage(shortages: Shortage[]): string {
  const first = shortages[0];
  const more = shortages.length > 1 ? ` (y ${shortages.length - 1} más)` : '';
  return `No hay stock suficiente de ${first.name}: quedan ${formatQty(first.available)} ${first.unit} y se necesitan ${formatQty(first.needed)}${more}`;
}

/**
 * Descuenta del stock lo consumido por una venta y deja un movimiento por cada insumo.
 * Se llama dentro de la transacción del cobro: o se registra todo, o nada.
 */
export async function deductForSale(
  tx: Prisma.TransactionClient,
  tenantId: string,
  ctx: InventoryContext,
  charged: StockRequest[],
  saleId: string,
  actorName: string,
) {
  const total = new Map<string, number>();
  for (const c of charged) {
    for (const [stockId, qty] of consumption(ctx, c.menuItemId, c.optionIds)) {
      total.set(stockId, (total.get(stockId) ?? 0) + qty * c.quantity);
    }
  }
  for (const [stockId, qty] of total) {
    const amount = round4(qty);
    if (amount <= 0) continue;
    const updated = await tx.stockItem.update({ where: { id: stockId }, data: { onHand: { decrement: amount } } });
    await tx.stockMovement.create({
      data: {
        tenantId,
        stockItemId: stockId,
        type: 'SALE',
        quantity: -amount,
        balanceAfter: round4(updated.onHand),
        reference: saleId,
        createdBy: actorName,
      },
    });
  }
}

/** Serializa los pedidos que tocan el stock de un negocio: dos mozos no pueden "llevarse" a la vez la última unidad. */
export async function lockStock(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM stock_items WHERE "tenantId" = ${tenantId} FOR UPDATE`);
}
