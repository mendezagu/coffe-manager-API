import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Payment, Prisma, Role, Sale, SaleItem } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { newTablePin } from '../qr/qr.tokens';
import { modifiersTotal, readSnapshot } from '../modifiers/modifiers.logic';
import { StockRequest, consumption, deductForSale, hasRecipe, loadContext, optionIdsOf, unitCost } from '../inventory/inventory.logic';

export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'qr', 'tarjeta'] as const;
export const MIXED_PAYMENT = 'mixto';

export interface PaymentInput {
  method: string;
  amount: number; // lo que se aplica a la cuenta (más propina) con este método
  tendered?: number; // solo efectivo: lo que entregó el cliente (el vuelto se calcula)
}

export interface CheckoutInput {
  checkoutId: string;
  // Atajo: un solo método por el total. Si viene `payments`, se usa eso.
  paymentMethod?: string;
  payments?: PaymentInput[];
  tip?: number; // propina en dinero (no es venta)
  globalDiscount?: number; // % sobre lo que no es promo
  items?: { orderId: string; discount: number }[]; // % por línea
  // Cobrar solo una parte de la mesa (división de cuenta por platos). Sin esto se cobra todo.
  lines?: { orderId: string; quantity: number }[];
}

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

type SaleDetail = Sale & { items?: SaleItem[]; payments?: Payment[] };

// Misma forma que devolvía /api/balances (la pantalla de Balance sigue funcionando),
// más lo nuevo: cajero, descuentos, propina, pagos y, si se pide, el detalle.
export function mapSale(sale: SaleDetail) {
  return {
    _id: sale.id,
    orderId: sale.checkoutId,
    tableName: sale.tableName,
    waiterName: sale.waiterName,
    cashierName: sale.cashierName,
    paymentMethod: sale.paymentMethod,
    grossTotal: sale.grossTotal,
    discountTotal: sale.discountTotal,
    globalDiscountPct: sale.globalDiscountPct,
    totalAmount: sale.totalAmount,
    tipAmount: sale.tipAmount,
    registerId: sale.registerId,
    date: sale.date,
    ...(sale.payments && {
      payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change })),
    }),
    ...(sale.items && {
      items: sale.items.map((i) => ({
        name: i.name,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
        note: i.note,
        isPromo: i.isPromo,
        discountPct: i.discountPct,
        lineTotal: i.lineTotal,
        modifiers: readSnapshot(i.modifiers).map((m) => ({ group: m.group, name: m.name, priceDelta: m.priceDelta })),
      })),
    }),
  };
}

// El dinero se maneja redondeado a centavos en cada paso, así lo que se suma coincide con lo que se imprime.
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const SALE_INCLUDE = { items: true, payments: true } as const;

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const sales = await this.prisma.sale.findMany({ where: { tenantId }, orderBy: { date: 'asc' } });
    return sales.map(mapSale);
  }

  async findOne(tenantId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, tenantId },
      include: { items: { orderBy: { name: 'asc' } }, payments: true },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada');
    return mapSale(sale);
  }

  // Solo borra las ventas del negocio del usuario, nunca las de otros.
  async removeAll(tenantId: string): Promise<{ message: string }> {
    await this.prisma.sale.deleteMany({ where: { tenantId } });
    return { message: 'Todos los balances han sido eliminados' };
  }

  /**
   * Cobra la mesa (o una parte) en UNA transacción: se guarda la venta con su detalle, sus pagos y su
   * propina, y se descuentan los platos cobrados de la mesa, o no pasa nada. La mesa se libera
   * solo cuando no queda nada por cobrar. El total lo calcula el servidor con los precios del menú;
   * el cliente solo manda qué descuentos y qué pagos quiere.
   */
  async checkout(tenantId: string, actor: Actor, tableId: string, input: CheckoutInput) {
    // Idempotencia: un reintento del mismo cobro devuelve la venta ya registrada.
    const already = await this.findByCheckoutId(tenantId, input.checkoutId);
    if (already) return already;

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    this.assertRegisterOpen(tenant);

    const itemDiscounts = new Map((input.items ?? []).map((i) => [i.orderId, i.discount]));
    const globalPct = input.globalDiscount ?? 0;
    const wantsDiscount = globalPct > 0 || [...itemDiscounts.values()].some((d) => d > 0);
    // Descuentos: el administrador siempre; el cajero solo si el negocio lo habilitó en "Mi negocio"
    const mayDiscount = actor.role === Role.ADMIN || (actor.role === Role.CASHIER && tenant.cashierDiscounts);
    if (wantsDiscount && !mayDiscount) {
      throw new ForbiddenException(
        actor.role === Role.CASHIER
          ? 'El negocio no habilitó los descuentos para el cajero'
          : 'Solo un administrador puede aplicar descuentos',
      );
    }

    const table = await this.prisma.table.findFirst({
      where: { id: tableId, tenantId },
      include: {
        waiter: true,
        orders: { include: { menuItem: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!table) throw new NotFoundException('Mesa no encontrada');
    if (table.controlledById) {
      throw new BadRequestException('Esta mesa está vinculada a otra: se cobra desde la mesa principal');
    }
    if (table.orders.length === 0) throw new BadRequestException('La mesa no tiene órdenes para cobrar');

    // ---- Qué se cobra: toda la mesa, o solo las líneas (y cantidades) indicadas ----
    const charge = this.resolveCharge(table.orders, input.lines);
    const isFull = table.orders.every((o) => charge.get(o.id) === o.quantity);

    const unknown = [...itemDiscounts.keys()].filter((id) => !charge.has(id));
    if (unknown.length) {
      throw new BadRequestException('Hay descuentos para órdenes que no se están cobrando. Reabrí el cobro.');
    }

    // Con inventario: lo que consume cada plato (para descontar el stock y calcular el costo de la venta)
    const inventory = tenant.inventoryEnabled ? await loadContext(this.prisma, tenantId) : null;
    const charged: StockRequest[] = [];

    // ---- Cálculo (la fuente de verdad del importe) ----
    let gross = 0;
    let lineSum = 0;
    let discountable = 0;
    const lines = table.orders
      .filter((order) => charge.has(order.id))
      .map((order) => {
        if (!order.menuItem) {
          throw new ConflictException(
            'Una de las órdenes es de un plato que ya no existe en el menú. Quitala de la mesa antes de cobrar.',
          );
        }
        const quantity = charge.get(order.id) as number;
        const { name, isPromo } = order.menuItem;
        // Precio de una unidad: el del plato + lo que sumaron las opciones elegidas al pedirlo
        const price = round2(order.menuItem.price + modifiersTotal(order.modifiers));
        // Las promos nunca llevan descuento, aunque llegue uno
        const discountPct = isPromo ? 0 : itemDiscounts.get(order.id) ?? 0;
        const lineGross = round2(price * quantity);
        const lineTotal = round2(lineGross * (1 - discountPct / 100));
        // Costo de una unidad con los costos de hoy (null si el plato no tiene receta: no se puede calcular)
        const optionIds = optionIdsOf(order.modifiers);
        let cost: number | null = null;
        if (inventory) {
          if (hasRecipe(inventory, order.menuItemId)) cost = unitCost(inventory, consumption(inventory, order.menuItemId, optionIds));
          if (order.menuItemId) charged.push({ menuItemId: order.menuItemId, quantity, optionIds });
        }
        gross += lineGross;
        lineSum += lineTotal;
        if (!isPromo) discountable += lineTotal;
        return {
          name,
          unitPrice: price,
          quantity,
          note: order.note,
          isPromo,
          discountPct,
          lineTotal,
          unitCost: cost,
          modifiers: readSnapshot(order.modifiers) as unknown as Prisma.InputJsonValue,
        };
      });
    const globalDiscountAmount = round2((discountable * globalPct) / 100);
    const totalAmount = round2(lineSum - globalDiscountAmount);
    const grossTotal = round2(gross);

    // ---- Propina y pagos ----
    const tipAmount = this.resolveTip(tenant, input.tip, totalAmount);
    const due = round2(totalAmount + tipAmount); // lo que el cliente entrega en total
    const payments = this.resolvePayments(input, due);
    const paymentMethod =
      payments.length === 1 ? payments[0].method : payments.length > 1 ? MIXED_PAYMENT : input.paymentMethod ?? 'efectivo';

    try {
      const sale = await this.prisma.$transaction(async (tx) => {
        // La caja se vuelve a mirar adentro de la transacción: pudo cerrarse mientras se armaba el cobro.
        const fresh = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        this.assertRegisterOpen(fresh);

        const created = await tx.sale.create({
          data: {
            tenantId,
            checkoutId: input.checkoutId,
            tableName: table.name,
            waiterName: table.waiter?.name ?? 'Sin asignar',
            cashierName: actor.name,
            paymentMethod,
            grossTotal,
            discountTotal: round2(grossTotal - totalAmount),
            globalDiscountPct: globalPct,
            totalAmount,
            tipAmount,
            // hora en que se abrió la mesa; en mesas abiertas antes de registrarla, la de su orden más vieja
            // (las órdenes vienen de la más vieja a la más nueva)
            tableOpenedAt: isFull ? table.openedAt ?? table.orders[0]?.createdAt ?? null : null,
            registerId: fresh.openRegisterId,
            items: { create: lines },
            payments: { create: payments },
          },
          include: SALE_INCLUDE,
        });

        // Con inventario, la venta descuenta los insumos consumidos (y deja el movimiento en el libro de stock)
        if (inventory) await deductForSale(tx, tenantId, inventory, charged, created.id, actor.name);

        if (isFull) {
          // Se cobró todo: liberar la mesa (igual que resetTable) dentro de la misma transacción
          await tx.order.deleteMany({ where: { tableId } });
          await tx.table.updateMany({
            where: { controlledById: tableId, tenantId },
            data: { controlledById: null, available: true },
          });
          await tx.table.update({ where: { id: tableId }, data: { available: true, waiterId: null, openedAt: null, qrPin: newTablePin() } });
        } else {
          // Cobro parcial: se descuentan los platos cobrados y la mesa sigue ocupada con el resto
          for (const order of table.orders) {
            const paid = charge.get(order.id);
            if (!paid) continue;
            if (paid === order.quantity) await tx.order.delete({ where: { id: order.id } });
            else await tx.order.update({ where: { id: order.id }, data: { quantity: order.quantity - paid } });
          }
        }
        return created;
      });
      return mapSale(sale);
    } catch (error) {
      // Dos pedidos simultáneos del mismo cobro: gana uno y el otro recibe esa misma venta.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findByCheckoutId(tenantId, input.checkoutId);
        if (existing) return existing;
      }
      throw error;
    }
  }

  // ---- reglas ----

  private assertRegisterOpen(tenant: { requireOpenRegister: boolean; openRegisterId: string | null }) {
    if (tenant.requireOpenRegister && !tenant.openRegisterId) {
      throw new ConflictException('No hay caja abierta. Abrí la caja para cobrar.');
    }
  }

  // Cantidad que se cobra de cada orden: por defecto todo; con `lines`, solo lo indicado.
  private resolveCharge(orders: { id: string; quantity: number }[], lines?: { orderId: string; quantity: number }[]) {
    const charge = new Map<string, number>();
    if (!lines || lines.length === 0) {
      for (const o of orders) charge.set(o.id, o.quantity);
      return charge;
    }
    for (const { orderId, quantity } of lines) {
      const order = orders.find((o) => o.id === orderId);
      if (!order) throw new BadRequestException('Hay platos a cobrar que ya no están en la mesa. Reabrí el cobro.');
      if (charge.has(orderId)) throw new BadRequestException('Un plato está repetido en el cobro');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > order.quantity) {
        throw new BadRequestException('La cantidad a cobrar de un plato no es válida');
      }
      charge.set(orderId, quantity);
    }
    return charge;
  }

  private resolveTip(tenant: { tipEnabled: boolean }, tip: number | undefined, total: number): number {
    const amount = round2(tip ?? 0);
    if (amount === 0) return 0;
    if (!tenant.tipEnabled) throw new BadRequestException('Las propinas no están activadas en este negocio');
    if (amount < 0 || !Number.isFinite(amount)) throw new BadRequestException('La propina no es válida');
    if (amount > Math.max(total, 1) * 2) throw new BadRequestException('La propina es demasiado alta');
    return amount;
  }

  /**
   * Arma los pagos y comprueba que sumen exactamente lo que hay que cobrar (cuenta + propina).
   * En efectivo calcula el vuelto a partir de lo que entregó el cliente.
   */
  private resolvePayments(input: CheckoutInput, due: number) {
    type Row = { method: string; amount: number; tendered: number | null; change: number };

    // Atajo: un solo método por el total
    if (!input.payments?.length) {
      if (due === 0) return [] as Row[]; // todo bonificado: no hay nada que cobrar
      this.assertMethod(input.paymentMethod);
      return [{ method: input.paymentMethod as string, amount: due, tendered: null, change: 0 }] as Row[];
    }

    const seen = new Set<string>();
    const rows: Row[] = input.payments.map((p) => {
      this.assertMethod(p.method);
      if (seen.has(p.method)) throw new BadRequestException(`El método "${p.method}" está repetido: sumá los importes en uno solo`);
      seen.add(p.method);

      const amount = round2(p.amount);
      if (!(amount > 0)) throw new BadRequestException('Cada pago tiene que ser mayor a cero');

      if (p.method !== 'efectivo' || p.tendered === undefined || p.tendered === null) {
        return { method: p.method, amount, tendered: null, change: 0 };
      }
      const tendered = round2(p.tendered);
      if (tendered < amount) throw new BadRequestException('El efectivo recibido es menor a lo que corresponde');
      return { method: p.method, amount, tendered, change: round2(tendered - amount) };
    });

    const paid = round2(rows.reduce((sum, r) => sum + r.amount, 0));
    if (paid !== due) {
      throw new BadRequestException(`Los pagos suman ${paid} y hay que cobrar ${due}`);
    }
    return rows;
  }

  private assertMethod(method: string | undefined) {
    if (!method || !(PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new BadRequestException('Método de pago no válido');
    }
  }

  private async findByCheckoutId(tenantId: string, checkoutId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { tenantId, checkoutId },
      include: SALE_INCLUDE,
    });
    return sale ? mapSale(sale) : null;
  }
}
