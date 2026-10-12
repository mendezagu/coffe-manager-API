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

  async sales(tenantId: string, query: SalesReportQuery) {
    const tz = query.tz || 'UTC';
    if (!isValidTimeZone(tz)) throw new BadRequestException('Zona horaria no válida');

    const to = query.to ?? localDay(new Date(), tz);
    const from = query.from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (from > to) throw new BadRequestException('La fecha "desde" no puede ser posterior a "hasta"');
    if (daysBetween(from, to) > MAX_DAYS) {
      throw new BadRequestException(`El rango máximo es de ${MAX_DAYS} días`);
    }

    const sales = await this.prisma.sale.findMany({
      where: { tenantId, date: { gte: startOfDay(from, tz), lt: startOfDay(addDays(to, 1), tz) } },
      include: { items: true },
      orderBy: { date: 'asc' },
    });

    // Un casillero por cada día del rango (los días sin ventas cuentan como 0 en el gráfico)
    const byDay = new Map<string, { salesCount: number; totalAmount: number }>();
    for (let n = 0, day = from; day <= to; day = addDays(from, ++n)) {
      byDay.set(day, { salesCount: 0, totalAmount: 0 });
    }

    const byWaiter = new Map<string, { salesCount: number; totalAmount: number }>();
    const byPayment = new Map<string, { salesCount: number; totalAmount: number }>();
    const items = new Map<string, { quantity: number; amount: number }>();
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
    let salesWithoutDetail = 0;

    for (const sale of sales) {
      totalAmount += sale.totalAmount;
      grossTotal += sale.grossTotal;
      discountTotal += sale.discountTotal;
      add(byDay, localDay(sale.date, tz), sale.totalAmount);
      add(byWaiter, sale.waiterName || 'Sin mozo', sale.totalAmount);
      add(byPayment, sale.paymentMethod || 'sin dato', sale.totalAmount);

      if (sale.items.length === 0) salesWithoutDetail += 1; // ventas del sistema anterior: sin platos
      for (const item of sale.items) {
        // El descuento general se reparte entre los platos que no son promo, así los importes
        // por plato suman lo realmente cobrado.
        const amount = item.isPromo ? item.lineTotal : item.lineTotal * (1 - sale.globalDiscountPct / 100);
        const row = items.get(item.name) ?? { quantity: 0, amount: 0 };
        row.quantity += item.quantity;
        row.amount += amount;
        items.set(item.name, row);
        itemsSold += item.quantity;
      }
    }

    const rank = <T extends { totalAmount: number }>(m: Map<string, T>, label: string) =>
      [...m.entries()]
        .map(([name, v]) => ({ [label]: name, ...v, totalAmount: round2(v.totalAmount) }))
        .sort((a: any, b: any) => b.totalAmount - a.totalAmount);

    return {
      range: { from, to, tz },
      summary: {
        salesCount: sales.length,
        totalAmount: round2(totalAmount),
        averageTicket: sales.length ? round2(totalAmount / sales.length) : 0,
        grossTotal: round2(grossTotal),
        discountTotal: round2(discountTotal),
        itemsSold,
        salesWithoutDetail,
      },
      byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v, totalAmount: round2(v.totalAmount) })),
      items: [...items.entries()]
        .map(([name, v]) => ({ name, quantity: v.quantity, amount: round2(v.amount) }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, MAX_ITEMS),
      byWaiter: rank(byWaiter, 'name'),
      byPayment: rank(byPayment, 'method'),
    };
  }
}
