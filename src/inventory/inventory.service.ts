import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockItem } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  Ingredient,
  InventoryContext,
  OptionLine,
  UNITS,
  availableStock,
  committedConsumption,
  loadContext,
  round2,
  round4,
  unitCost,
} from './inventory.logic';

const MAX_QTY = 1_000_000_000;
const normalize = (name: string) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export type StockStatus = 'ok' | 'low' | 'out';
export const stockStatus = (onHand: number, minStock: number): StockStatus =>
  onHand <= 0 ? 'out' : minStock > 0 && onHand <= minStock ? 'low' : 'ok';

type Db = PrismaService | Prisma.TransactionClient;

export interface ItemInput {
  name?: string;
  unit?: string;
  minStock?: number;
  costPerUnit?: number;
  active?: boolean;
  initialQuantity?: number;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // =============== Insumos ===============

  async listItems(tenantId: string) {
    const [ctx, items] = await Promise.all([
      loadContext(this.prisma, tenantId),
      this.prisma.stockItem.findMany({
        where: { tenantId },
        include: { _count: { select: { menuIngredients: true, optionIngredients: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const committed = await committedConsumption(this.prisma, tenantId, ctx);
    const available = availableStock(ctx, committed);

    return items.map((i) => ({
      _id: i.id,
      name: i.name,
      unit: i.unit,
      onHand: i.onHand,
      minStock: i.minStock,
      costPerUnit: i.costPerUnit,
      active: i.active,
      committed: round4(committed.get(i.id) ?? 0),
      available: available.get(i.id) ?? i.onHand,
      status: stockStatus(i.onHand, i.minStock),
      usedIn: i._count.menuIngredients + i._count.optionIngredients,
    }));
  }

  async createItem(tenantId: string, actorName: string, input: ItemInput) {
    const name = this.cleanName(input.name);
    const unit = this.cleanUnit(input.unit ?? 'unidad');
    const minStock = this.cleanQty(input.minStock ?? 0, 'El stock mínimo', true);
    const costPerUnit = this.cleanQty(input.costPerUnit ?? 0, 'El costo', true);
    const initial = this.cleanQty(input.initialQuantity ?? 0, 'La cantidad inicial', true);
    await this.assertNameFree(tenantId, name);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const item = await tx.stockItem.create({ data: { tenantId, name, unit, minStock, costPerUnit, onHand: initial } });
        if (initial > 0) {
          await tx.stockMovement.create({
            data: { tenantId, stockItemId: item.id, type: 'ADJUSTMENT', quantity: initial, balanceAfter: initial, note: 'Stock inicial', createdBy: actorName },
          });
        }
        return this.mapItem(item);
      });
    } catch (error) {
      this.rethrowDuplicate(error);
      throw error;
    }
  }

  async updateItem(tenantId: string, id: string, input: ItemInput) {
    const current = await this.requireItem(this.prisma, tenantId, id);
    if (input.unit !== undefined && input.unit !== current.unit) {
      throw new BadRequestException('La unidad de medida no se puede cambiar: borrá el insumo y creá uno nuevo');
    }
    const name = input.name === undefined ? undefined : this.cleanName(input.name);
    if (name !== undefined) await this.assertNameFree(tenantId, name, id);

    try {
      const item = await this.prisma.stockItem.update({
        where: { id },
        data: {
          name,
          active: input.active,
          minStock: input.minStock === undefined ? undefined : this.cleanQty(input.minStock, 'El stock mínimo', true),
          costPerUnit: input.costPerUnit === undefined ? undefined : this.cleanQty(input.costPerUnit, 'El costo', true),
        },
      });
      return this.mapItem(item);
    } catch (error) {
      this.rethrowDuplicate(error);
      throw error;
    }
  }

  // Un insumo que está en recetas no se borra: se desactiva (o se lo saca antes de las recetas)
  async removeItem(tenantId: string, id: string): Promise<{ message: string }> {
    await this.requireItem(this.prisma, tenantId, id);
    const [dishes, options] = await Promise.all([
      this.prisma.menuItemIngredient.count({ where: { stockItemId: id } }),
      this.prisma.modifierOptionIngredient.count({ where: { stockItemId: id } }),
    ]);
    if (dishes + options > 0) {
      throw new ConflictException(
        `Se usa en ${dishes} ${dishes === 1 ? 'receta' : 'recetas'}${options ? ` y ${options} ${options === 1 ? 'opción' : 'opciones'}` : ''}. Sacalo de ahí o desactivalo.`,
      );
    }
    await this.prisma.stockItem.delete({ where: { id } });
    return { message: 'Insumo eliminado' };
  }

  // =============== Movimientos ===============

  /** Entrada de mercadería. Con costo, actualiza el costo promedio ponderado. */
  async purchase(tenantId: string, actorName: string, id: string, input: { quantity: number; unitCost?: number; supplier?: string; note?: string }) {
    const quantity = this.cleanQty(input.quantity, 'La cantidad');
    const unitCostInput = input.unitCost === undefined || input.unitCost === null ? undefined : this.cleanQty(input.unitCost, 'El costo', true);

    return this.prisma.$transaction(async (tx) => {
      const item = await this.lockedItem(tx, tenantId, id);
      const onHand = round4(item.onHand + quantity);
      // promedio ponderado: lo que ya había (a su costo) + lo que entra (al costo de esta compra)
      const costPerUnit =
        unitCostInput === undefined
          ? item.costPerUnit
          : item.onHand > 0
            ? round4((item.onHand * item.costPerUnit + quantity * unitCostInput) / onHand)
            : unitCostInput;

      const updated = await tx.stockItem.update({ where: { id }, data: { onHand, costPerUnit } });
      await tx.stockMovement.create({
        data: {
          tenantId, stockItemId: id, type: 'PURCHASE', quantity, balanceAfter: onHand,
          unitCost: unitCostInput ?? null,
          supplier: (input.supplier ?? '').trim().slice(0, 80),
          note: (input.note ?? '').trim().slice(0, 200),
          createdBy: actorName,
        },
      });
      return this.mapItem(updated);
    });
  }

  /** Merma: rotura, vencimiento, error. Siempre con motivo. */
  async waste(tenantId: string, actorName: string, id: string, input: { quantity: number; reason: string }) {
    const quantity = this.cleanQty(input.quantity, 'La cantidad');
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Indicá el motivo de la merma');
    if (reason.length > 200) throw new BadRequestException('El motivo es demasiado largo (máximo 200 caracteres)');

    return this.prisma.$transaction(async (tx) => {
      const item = await this.lockedItem(tx, tenantId, id);
      if (quantity > item.onHand + 1e-9) {
        throw new BadRequestException(`No podés dar de baja ${quantity} ${item.unit}: solo hay ${item.onHand}. Si el stock está mal, hacé un ajuste.`);
      }
      const onHand = round4(item.onHand - quantity);
      const updated = await tx.stockItem.update({ where: { id }, data: { onHand } });
      await tx.stockMovement.create({
        data: { tenantId, stockItemId: id, type: 'WASTE', quantity: -quantity, balanceAfter: onHand, note: reason, createdBy: actorName },
      });
      return this.mapItem(updated);
    });
  }

  /** Deja el stock en la cantidad contada y registra la diferencia. */
  async adjust(tenantId: string, actorName: string, id: string, input: { counted: number; note?: string }) {
    const counted = this.cleanQty(input.counted, 'La cantidad contada', true);
    return this.prisma.$transaction(async (tx) => this.applyCount(tx, tenantId, actorName, id, counted, input.note ?? 'Ajuste'));
  }

  /** Conteo físico: varios insumos a la vez. Devuelve qué diferencias encontró y cuánto valen. */
  async count(tenantId: string, actorName: string, input: { counts: { stockItemId: string; counted: number }[]; note?: string }) {
    if (!input.counts?.length) throw new BadRequestException('No hay nada para contar');
    const ids = input.counts.map((c) => c.stockItemId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Un insumo está repetido en el conteo');

    return this.prisma.$transaction(async (tx) => {
      const rows: { stockItemId: string; name: string; unit: string; expected: number; counted: number; difference: number; value: number }[] = [];
      for (const c of input.counts) {
        const counted = this.cleanQty(c.counted, 'La cantidad contada', true);
        const before = await this.lockedItem(tx, tenantId, c.stockItemId);
        const difference = round4(counted - before.onHand);
        if (difference !== 0) await this.applyCount(tx, tenantId, actorName, c.stockItemId, counted, input.note?.trim() || 'Conteo físico');
        rows.push({
          stockItemId: before.id, name: before.name, unit: before.unit,
          expected: before.onHand, counted, difference, value: round2(difference * before.costPerUnit),
        });
      }
      return { items: rows, differences: rows.filter((r) => r.difference !== 0).length, totalValue: round2(rows.reduce((s, r) => s + r.value, 0)) };
    });
  }

  async movements(tenantId: string, filter: { stockItemId?: string; limit?: number }) {
    const rows = await this.prisma.stockMovement.findMany({
      where: { tenantId, ...(filter.stockItemId ? { stockItemId: filter.stockItemId } : {}) },
      include: { stockItem: { select: { name: true, unit: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filter.limit ?? 100, 1), 500),
    });
    return rows.map((m) => ({
      id: m.id,
      stockItemId: m.stockItemId,
      name: m.stockItem.name,
      unit: m.stockItem.unit,
      type: m.type,
      quantity: m.quantity,
      balanceAfter: m.balanceAfter,
      unitCost: m.unitCost,
      supplier: m.supplier,
      note: m.note,
      reference: m.reference,
      createdBy: m.createdBy,
      createdAt: m.createdAt,
    }));
  }

  /** Para el aviso del encabezado: cuántos insumos están bajos o agotados. */
  async summary(tenantId: string) {
    const items = await this.prisma.stockItem.findMany({ where: { tenantId, active: true } });
    const statuses = items.map((i) => stockStatus(i.onHand, i.minStock));
    return {
      itemsCount: items.length,
      lowCount: statuses.filter((s) => s === 'low').length,
      outCount: statuses.filter((s) => s === 'out').length,
    };
  }

  // =============== Recetas ===============

  /** Todos los platos con su receta, costo y margen (alimenta Recetas y Rentabilidad). */
  async recipes(tenantId: string) {
    const [ctx, dishes] = await Promise.all([
      loadContext(this.prisma, tenantId),
      this.prisma.menuItem.findMany({ where: { tenantId }, select: { id: true, name: true, price: true, isPromo: true, categoryId: true }, orderBy: { name: 'asc' } }),
    ]);
    return dishes.map((d) => {
      const ingredients = this.describe(ctx, ctx.recipes.get(d.id) ?? []);
      const hasRecipe = ingredients.length > 0;
      const cost = hasRecipe ? unitCost(ctx, new Map((ctx.recipes.get(d.id) ?? []).map((i) => [i.stockItemId, i.quantity]))) : null;
      const margin = cost === null ? null : round2(d.price - cost);
      return {
        menuItemId: d.id,
        name: d.name,
        price: d.price,
        isPromo: d.isPromo,
        categoryId: d.categoryId,
        ingredients,
        cost: cost === null ? null : round2(cost),
        margin,
        marginPct: cost === null || d.price <= 0 ? null : round2(((d.price - cost) / d.price) * 100),
      };
    });
  }

  async setRecipe(tenantId: string, menuItemId: string, ingredients: { stockItemId: string; quantity: number }[]) {
    const dish = await this.prisma.menuItem.findFirst({ where: { id: menuItemId, tenantId } });
    if (!dish) throw new NotFoundException('Plato no encontrado');
    const lines = await this.cleanLines(tenantId, ingredients, false);

    await this.prisma.$transaction(async (tx) => {
      await tx.menuItemIngredient.deleteMany({ where: { menuItemId } });
      if (lines.length) await tx.menuItemIngredient.createMany({ data: lines.map((l) => ({ menuItemId, stockItemId: l.stockItemId, quantity: l.quantity })) });
    });
    return (await this.recipes(tenantId)).find((r) => r.menuItemId === menuItemId);
  }

  // =============== Insumos de las opciones (extras) ===============

  async options(tenantId: string) {
    const [ctx, groups] = await Promise.all([
      loadContext(this.prisma, tenantId),
      this.prisma.modifierGroup.findMany({
        where: { tenantId },
        include: { options: { orderBy: { position: 'asc' } } },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return groups.flatMap((g) =>
      g.options.map((o) => {
        const lines = ctx.optionLines.get(o.id) ?? [];
        return {
          optionId: o.id,
          groupId: g.id,
          groupName: g.name,
          name: o.name,
          priceDelta: o.priceDelta,
          active: o.active,
          ingredients: lines.map((l) => ({
            stockItemId: l.stockItemId,
            name: ctx.stock.get(l.stockItemId)?.name ?? 'insumo',
            unit: ctx.stock.get(l.stockItemId)?.unit ?? '',
            quantity: l.quantity,
            replacesStockItemId: l.replacesStockItemId,
          })),
        };
      }),
    );
  }

  async setOptionIngredients(tenantId: string, optionId: string, lines: { stockItemId: string; quantity: number; replacesStockItemId?: string | null }[]) {
    const option = await this.prisma.modifierOption.findFirst({ where: { id: optionId, group: { tenantId } } });
    if (!option) throw new NotFoundException('Opción no encontrada');
    const clean = await this.cleanLines(tenantId, lines, true);

    await this.prisma.$transaction(async (tx) => {
      await tx.modifierOptionIngredient.deleteMany({ where: { optionId } });
      if (clean.length) {
        await tx.modifierOptionIngredient.createMany({
          data: clean.map((l) => ({ optionId, stockItemId: l.stockItemId, quantity: l.quantity, replacesStockItemId: l.replacesStockItemId ?? null })),
        });
      }
    });
    return (await this.options(tenantId)).find((o) => o.optionId === optionId);
  }

  // =============== utilidades ===============

  private describe(ctx: InventoryContext, list: Ingredient[]) {
    return list.map((i) => ({
      stockItemId: i.stockItemId,
      name: ctx.stock.get(i.stockItemId)?.name ?? 'insumo',
      unit: ctx.stock.get(i.stockItemId)?.unit ?? '',
      quantity: i.quantity,
    }));
  }

  private mapItem(i: StockItem) {
    return {
      _id: i.id,
      name: i.name,
      unit: i.unit,
      onHand: i.onHand,
      minStock: i.minStock,
      costPerUnit: i.costPerUnit,
      active: i.active,
      status: stockStatus(i.onHand, i.minStock),
    };
  }

  private async applyCount(tx: Prisma.TransactionClient, tenantId: string, actorName: string, id: string, counted: number, note: string) {
    const item = await this.lockedItem(tx, tenantId, id);
    const difference = round4(counted - item.onHand);
    if (difference === 0) return this.mapItem(item);
    const updated = await tx.stockItem.update({ where: { id }, data: { onHand: counted } });
    await tx.stockMovement.create({
      data: { tenantId, stockItemId: id, type: 'ADJUSTMENT', quantity: difference, balanceAfter: counted, note: note.trim().slice(0, 200), createdBy: actorName },
    });
    return this.mapItem(updated);
  }

  // Lee el insumo bloqueando su fila: dos operaciones simultáneas no se pisan
  private async lockedItem(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM stock_items WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`);
    return this.requireItem(tx, tenantId, id);
  }

  private async requireItem(db: Db, tenantId: string, id: string) {
    const item = await db.stockItem.findFirst({ where: { id, tenantId } });
    if (!item) throw new NotFoundException('Insumo no encontrado');
    return item;
  }

  // Valida las líneas de una receta u opción: insumos del negocio, cantidades y sin repetir
  private async cleanLines<T extends { stockItemId: string; quantity: number; replacesStockItemId?: string | null }>(tenantId: string, lines: T[], allowZero: boolean) {
    const list = lines ?? [];
    const ids = list.map((l) => l.stockItemId);
    if (new Set(ids).size !== ids.length) throw new ConflictException('Un insumo está repetido');
    const replaced = list.map((l) => l.replacesStockItemId).filter((x): x is string => !!x);
    const needed = [...new Set([...ids, ...replaced])];
    if (needed.length) {
      const found = await this.prisma.stockItem.count({ where: { id: { in: needed }, tenantId } });
      if (found !== needed.length) throw new NotFoundException('Insumo no encontrado');
    }
    return list.map((l) => ({
      ...l,
      quantity: this.cleanQty(l.quantity, 'La cantidad de un insumo', allowZero),
    }));
  }

  private cleanName(name: unknown): string {
    const cleaned = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!cleaned) throw new BadRequestException('El nombre es obligatorio');
    if (cleaned.length > 60) throw new BadRequestException('El nombre es demasiado largo (máximo 60 caracteres)');
    return cleaned;
  }

  private cleanUnit(unit: string): string {
    if (!(UNITS as readonly string[]).includes(unit)) {
      throw new BadRequestException(`Unidad no válida. Opciones: ${UNITS.join(', ')}`);
    }
    return unit;
  }

  private cleanQty(value: unknown, label: string, allowZero = false): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > MAX_QTY || (!allowZero && n === 0)) {
      throw new BadRequestException(`${label} no es válida`);
    }
    return round4(n);
  }

  private async assertNameFree(tenantId: string, name: string, excludeId?: string) {
    const target = normalize(name);
    const all = await this.prisma.stockItem.findMany({ where: { tenantId }, select: { id: true, name: true } });
    if (all.some((i) => i.id !== excludeId && normalize(i.name) === target)) {
      throw new ConflictException('Ya existe un insumo con ese nombre');
    }
  }

  private rethrowDuplicate(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe un insumo con ese nombre');
    }
  }
}

// re-export para los tests
export type { OptionLine };
