import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, Sale, SaleItem } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { modifiersTotal, readSnapshot } from '../modifiers/modifiers.logic';

export const PAYMENT_METHODS = ['efectivo', 'transferencia', 'qr', 'tarjeta'] as const;

export interface CheckoutInput {
  checkoutId: string;
  paymentMethod: string;
  globalDiscount?: number; // % sobre lo que no es promo
  items?: { orderId: string; discount: number }[]; // % por línea
}

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

type SaleWithItems = Sale & { items?: SaleItem[] };

// Misma forma que devolvía /api/balances (la pantalla de Balance sigue funcionando),
// más lo nuevo: cajero, descuentos y, si se pide, el detalle.
export function mapSale(sale: SaleWithItems) {
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
    date: sale.date,
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
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

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
      include: { items: { orderBy: { name: 'asc' } } },
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
   * Cobra la mesa y la libera en UNA transacción: se guarda la venta (con el detalle) y se
   * vacía la mesa, o no pasa nada. El total lo calcula el servidor con los precios del menú;
   * el cliente solo manda qué descuentos se piden.
   */
  async checkout(tenantId: string, actor: Actor, tableId: string, input: CheckoutInput) {
    // Idempotencia: un reintento del mismo cobro devuelve la venta ya registrada.
    const already = await this.findByCheckoutId(tenantId, input.checkoutId);
    if (already) return already;

    if (!(PAYMENT_METHODS as readonly string[]).includes(input.paymentMethod)) {
      throw new BadRequestException('Método de pago no válido');
    }

    const itemDiscounts = new Map((input.items ?? []).map((i) => [i.orderId, i.discount]));
    const globalPct = input.globalDiscount ?? 0;
    const wantsDiscount = globalPct > 0 || [...itemDiscounts.values()].some((d) => d > 0);
    if (wantsDiscount && actor.role !== Role.ADMIN) {
      throw new ForbiddenException('Solo un administrador puede aplicar descuentos');
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

    const unknown = [...itemDiscounts.keys()].filter((id) => !table.orders.some((o) => o.id === id));
    if (unknown.length) {
      throw new BadRequestException('Hay descuentos para órdenes que ya no están en la mesa. Reabrí el cobro.');
    }

    // ---- Cálculo (la fuente de verdad del importe) ----
    let gross = 0;
    let lineSum = 0;
    let discountable = 0;
    const lines = table.orders.map((order) => {
      if (!order.menuItem) {
        throw new ConflictException(
          'Una de las órdenes es de un plato que ya no existe en el menú. Quitala de la mesa antes de cobrar.',
        );
      }
      const { name, isPromo } = order.menuItem;
      // Precio de una unidad: el del plato + lo que sumaron las opciones elegidas al pedirlo
      const price = round2(order.menuItem.price + modifiersTotal(order.modifiers));
      // Las promos nunca llevan descuento, aunque llegue uno
      const discountPct = isPromo ? 0 : itemDiscounts.get(order.id) ?? 0;
      const lineGross = round2(price * order.quantity);
      const lineTotal = round2(lineGross * (1 - discountPct / 100));
      gross += lineGross;
      lineSum += lineTotal;
      if (!isPromo) discountable += lineTotal;
      return {
        name,
        unitPrice: price,
        quantity: order.quantity,
        note: order.note,
        isPromo,
        discountPct,
        lineTotal,
        modifiers: readSnapshot(order.modifiers) as unknown as Prisma.InputJsonValue,
      };
    });
    const globalDiscountAmount = round2((discountable * globalPct) / 100);
    const totalAmount = round2(lineSum - globalDiscountAmount);
    const grossTotal = round2(gross);

    try {
      const sale = await this.prisma.$transaction(async (tx) => {
        const created = await tx.sale.create({
          data: {
            tenantId,
            checkoutId: input.checkoutId,
            tableName: table.name,
            waiterName: table.waiter?.name ?? 'Sin asignar',
            cashierName: actor.name,
            paymentMethod: input.paymentMethod,
            grossTotal,
            discountTotal: round2(grossTotal - totalAmount),
            globalDiscountPct: globalPct,
            totalAmount,
            items: { create: lines },
          },
          include: { items: true },
        });

        // Liberar la mesa (igual que resetTable) dentro de la misma transacción
        await tx.order.deleteMany({ where: { tableId } });
        await tx.table.updateMany({
          where: { controlledById: tableId, tenantId },
          data: { controlledById: null, available: true },
        });
        await tx.table.update({ where: { id: tableId }, data: { available: true, waiterId: null } });
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

  private async findByCheckoutId(tenantId: string, checkoutId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { tenantId, checkoutId },
      include: { items: true },
    });
    return sale ? mapSale(sale) : null;
  }
}
