import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { addDays, daysBetween, isValidTimeZone, localDay, startOfDay } from './zoned-date';

export interface SalesReportQuery {
  from?: string; // YYYY-MM-DD, inclusive (en la zona `tz`)
  to?: string; // YYYY-MM-DD, inclusive
  tz?: string;
}

const MAX_DAYS = 366;
const DEFAULT_DAYS = 30;
const MAX_ITEMS = 100;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resumen del momento para el Inicio del administrador: ventas de hoy comparadas con ayer HASTA LA MISMA
   * HORA (si no, a media mañana siempre "bajaría") y cuánto tiempo estuvieron ocupadas las mesas hoy.
   */
  async live(tenantId: string, tz = 'UTC', now = new Date(), shiftStart?: Date) {
    if (!isValidTimeZone(tz)) throw new BadRequestException('Zona horaria no válida');

    // El turno en curso es del negocio (lo ven todos los dispositivos): si no se pasa uno, se toma el guardado
    if (shiftStart === undefined) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { shiftStartedAt: true } });
      shiftStart = tenant?.shiftStartedAt ?? undefined;
    }

    const today = localDay(now, tz);
    const todayStart = startOfDay(today, tz);
    const yesterdayStart = startOfDay(addDays(today, -1), tz);
    const yesterdayNow = new Date(yesterdayStart.getTime() + (now.getTime() - todayStart.getTime()));

    // Con un turno en curso el Inicio cuenta solo desde que se comenzó (aunque cruce la medianoche) y no se
    // compara con ayer: arranca en cero. El historial completo queda en los reportes.
    const from = shiftStart && shiftStart.getTime() <= now.getTime() ? shiftStart : todayStart;
    const compare = from === todayStart;

    const [todaySales, yesterdaySales] = await Promise.all([
      this.prisma.sale.findMany({
        where: { tenantId, date: { gte: from, lte: now } },
        select: { totalAmount: true, date: true, tableOpenedAt: true },
      }),
      compare
        ? this.prisma.sale.aggregate({
            where: { tenantId, date: { gte: yesterdayStart, lte: yesterdayNow } },
            _sum: { totalAmount: true },
            _count: true,
          })
        : Promise.resolve({ _sum: { totalAmount: 0 }, _count: 0 }),
    ]);

    const total = round2(todaySales.reduce((sum, s) => sum + s.totalAmount, 0));
    const previous = round2(yesterdaySales._sum.totalAmount ?? 0);

    // Permanencia: de la primera orden hasta el cobro que liberó la mesa
    const stays = todaySales
      .filter((s) => s.tableOpenedAt)
      .map((s) => (s.date.getTime() - s.tableOpenedAt!.getTime()) / 60000)
      .filter((m) => m >= 0);

    return {
      sales: { total, count: todaySales.length },
      yesterday: { total: previous, count: yesterdaySales._count },
      // null si ayer a esta hora no se vendió nada (no hay con qué comparar)
      changePct: previous > 0 ? round2(((total - previous) / previous) * 100) : null,
      averageStayMinutes: stays.length ? Math.round(stays.reduce((a, b) => a + b, 0) / stays.length) : null,
      staysCount: stays.length,
    };
  }

  async sales(tenantId: string, query: SalesReportQuery) {
    const tz = query.tz || 'UTC';
    if (!isValidTimeZone(tz)) throw new BadRequestException('Zona horaria no válida');

    const to = query.to ?? localDay(new Date(), tz);
    const from = query.from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (from > to) throw new BadRequestException('La fecha "desde" no puede ser posterior a "hasta"');
    if (daysBetween(from, to) > MAX_DAYS) {
      throw new BadRequestException(`El rango máximo es de ${MAX_DAYS} días`);
    }

    const commissionSettings = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { commissionEnabled: true, commissionPct: true },
    });

    const sales = await this.prisma.sale.findMany({
      where: { tenantId, date: { gte: startOfDay(from, tz), lt: startOfDay(addDays(to, 1), tz) } },
      include: { items: true, payments: true },
      orderBy: { date: 'asc' },
    });

    // Un casillero por cada día del rango (los días sin ventas cuentan como 0 en el gráfico)
    const byDay = new Map<string, { salesCount: number; totalAmount: number }>();
    for (let n = 0, day = from; day <= to; day = addDays(from, ++n)) {
      byDay.set(day, { salesCount: 0, totalAmount: 0 });
    }

    const byWaiter = new Map<string, { salesCount: number; totalAmount: number }>();
    const byPayment = new Map<string, { salesCount: number; totalAmount: number }>();
    const byTable = new Map<string, { salesCount: number; totalAmount: number }>();
    const items = new Map<string, { quantity: number; amount: number; costQty: number; costAmount: number; cost: number }>();
    const add = (m: Map<string, { salesCount: number; totalAmount: number }>, key: string, amount: number) => {
      const row = m.get(key) ?? { salesCount: 0, totalAmount: 0 };
      row.salesCount += 1;
      row.totalAmount += amount;
      m.set(key, row);
    };

    let totalAmount = 0;
    let grossTotal = 0;
    let discountTotal = 0;
    let itemsSold = 0;
    // Ganancia: solo se calcula sobre lo vendido con costo conocido (platos con receta)
    let knownRevenue = 0;
    let unknownRevenue = 0;
    let costTotal = 0;
    let salesWithoutDetail = 0;
    let tipsTotal = 0;
    const waiterTips = new Map<string, number>();
    // Comisión de cada mozo: lo vendido por el porcentaje que regía en cada venta
    const waiterCommission = new Map<string, number>();
    let commissionTotal = 0;
    // Ventas con voucher de hotel: cuánto trajo y cuánto se descontó por cada hotel
    const hotelAgg = new Map<string, { salesCount: number; totalAmount: number; discountTotal: number }>();

    for (const sale of sales) {
      totalAmount += sale.totalAmount;
      grossTotal += sale.grossTotal;
      discountTotal += sale.discountTotal;
      add(byDay, localDay(sale.date, tz), sale.totalAmount);
      add(byWaiter, sale.waiterName || 'Sin mozo', sale.totalAmount);
      add(byTable, sale.tableName || 'Sin mesa', sale.totalAmount);
      // Por método de pago se cuenta lo que realmente entró con cada uno (un cobro mixto suma en varios).
      // Las ventas viejas sin pagos registrados cuentan con su método único.
      if (sale.payments.length) for (const p of sale.payments) add(byPayment, p.method, p.amount);
      else add(byPayment, sale.paymentMethod || 'sin dato', sale.totalAmount);
      if (sale.hotelId) {
        const row = hotelAgg.get(sale.hotelId) ?? { salesCount: 0, totalAmount: 0, discountTotal: 0 };
        row.salesCount += 1;
        row.totalAmount += sale.totalAmount;
        row.discountTotal += sale.discountTotal;
        hotelAgg.set(sale.hotelId, row);
      }
      if (sale.commissionPct > 0) {
        const commission = (sale.totalAmount * sale.commissionPct) / 100;
        const who = sale.waiterName || 'Sin mozo';
        waiterCommission.set(who, (waiterCommission.get(who) ?? 0) + commission);
        commissionTotal += commission;
      }
      // La propina no es venta: va aparte y es del mozo
      tipsTotal += sale.tipAmount;
      if (sale.tipAmount > 0) {
        const key = sale.waiterName || 'Sin mozo';
        waiterTips.set(key, (waiterTips.get(key) ?? 0) + sale.tipAmount);
      }

      if (sale.items.length === 0) salesWithoutDetail += 1; // ventas del sistema anterior: sin platos
      for (const item of sale.items) {
        // El descuento general se reparte entre los platos que no son promo, así los importes
        // por plato suman lo realmente cobrado.
        const amount = item.isPromo ? item.lineTotal : item.lineTotal * (1 - sale.globalDiscountPct / 100);
        const row = items.get(item.name) ?? { quantity: 0, amount: 0, costQty: 0, costAmount: 0, cost: 0 };
        row.quantity += item.quantity;
        row.amount += amount;
        if (item.unitCost !== null) {
          const cost = item.unitCost * item.quantity;
          row.costQty += item.quantity;
          row.costAmount += amount;
          row.cost += cost;
          knownRevenue += amount;
          costTotal += cost;
        } else {
          unknownRevenue += amount;
        }
        items.set(item.name, row);
        itemsSold += item.quantity;
      }
    }

    const hotelNames = hotelAgg.size
      ? new Map((await this.prisma.hotel.findMany({ where: { id: { in: [...hotelAgg.keys()] } }, select: { id: true, name: true } })).map((h) => [h.id, h.name]))
      : new Map<string, string>();

    const rank = <T extends { totalAmount: number }>(m: Map<string, T>, label: string) =>
      [...m.entries()]
        .map(([name, v]) => ({ [label]: name, ...v, totalAmount: round2(v.totalAmount) }))
        .sort((a: any, b: any) => b.totalAmount - a.totalAmount);

    return {
      range: { from, to, tz },
      // cómo está configurada hoy la comisión (para mostrar u ocultar esa parte de la pantalla)
      commission: { enabled: commissionSettings?.commissionEnabled ?? false, pct: commissionSettings?.commissionPct ?? 0 },
      summary: {
        salesCount: sales.length,
        totalAmount: round2(totalAmount),
        averageTicket: sales.length ? round2(totalAmount / sales.length) : 0,
        grossTotal: round2(grossTotal),
        discountTotal: round2(discountTotal),
        itemsSold,
        salesWithoutDetail,
        tipsTotal: round2(tipsTotal),
        commissionTotal: round2(commissionTotal),
        // costo y ganancia de lo vendido con receta; revenueWithoutCost = lo vendido sin costo conocido
        costTotal: round2(costTotal),
        profit: round2(knownRevenue - costTotal),
        profitMarginPct: knownRevenue > 0 ? round2(((knownRevenue - costTotal) / knownRevenue) * 100) : null,
        revenueWithoutCost: round2(unknownRevenue),
      },
      byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v, totalAmount: round2(v.totalAmount) })),
      items: [...items.entries()]
        .map(([name, v]) => ({
          name,
          quantity: v.quantity,
          amount: round2(v.amount),
          cost: v.costQty ? round2(v.cost) : null,
          profit: v.costQty ? round2(v.costAmount - v.cost) : null,
        }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, MAX_ITEMS),
      byWaiter: rank(byWaiter, 'name').map((w: any) => ({
        ...w,
        tips: round2(waiterTips.get(w.name) ?? 0),
        commission: round2(waiterCommission.get(w.name) ?? 0),
      })),
      byPayment: rank(byPayment, 'method'),
      // Mesas más ocupadas: cuántas veces se cobró cada una (empata por importe), las 10 primeras
      byTable: [...byTable.entries()]
        .map(([name, v]) => ({ name, salesCount: v.salesCount, totalAmount: round2(v.totalAmount) }))
        .sort((a, b) => b.salesCount - a.salesCount || b.totalAmount - a.totalAmount)
        .slice(0, 10),
      byHotel: [...hotelAgg.entries()]
        .map(([hotelId, v]) => ({
          hotelId,
          name: hotelNames.get(hotelId) ?? 'Hotel',
          salesCount: v.salesCount,
          totalAmount: round2(v.totalAmount),
          discountTotal: round2(v.discountTotal),
          averageTicket: round2(v.totalAmount / v.salesCount),
        }))
        .sort((a, b) => b.totalAmount - a.totalAmount),
    };
  }
}
