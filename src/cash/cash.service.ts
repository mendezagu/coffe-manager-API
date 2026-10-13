import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CashMovementType, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export interface CashActor {
  id: string;
  name: string;
  role: Role;
}

const MAX_AMOUNT = 1_000_000_000;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class CashService {
  constructor(private readonly prisma: PrismaService) {}

  /** Estado de la caja del negocio: cerrada, o abierta con su resumen en vivo (según quién mire). */
  async current(tenantId: string, role: Role) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const base = { open: false, requireOpenRegister: tenant.requireOpenRegister };
    if (!tenant.openRegisterId) return { ...base, register: null };
    const summary = await this.summarize(this.prisma, tenantId, tenant.openRegisterId);
    return { ...base, open: true, register: this.viewFor(summary, role) };
  }

  /** Abre la caja con el efectivo inicial (fondo). Hay una sola caja abierta por negocio. */
  async open(tenantId: string, actor: CashActor, openingAmount: number) {
    const amount = this.cleanAmount(openingAmount, 'El efectivo inicial', true);
    const id = randomUUID();

    await this.prisma.$transaction(async (tx) => {
      await tx.cashRegister.create({ data: { id, tenantId, openedByName: actor.name, openingAmount: amount } });
      // Condicional: si otra caja ya quedó abierta, no se actualiza nada y se deshace todo.
      const { count } = await tx.tenant.updateMany({ where: { id: tenantId, openRegisterId: null }, data: { openRegisterId: id } });
      if (count === 0) throw new ConflictException('Ya hay una caja abierta');
    });
    return this.viewFor(await this.summarize(this.prisma, tenantId, id), actor.role);
  }

  /** Ingreso o retiro de efectivo que no es una venta (cambio, pago a un proveedor, retiro al banco). */
  async addMovement(tenantId: string, actor: CashActor, input: { type: CashMovementType; amount: number; reason: string }) {
    const registerId = await this.requireOpenRegisterId(this.prisma, tenantId);
    const amount = this.cleanAmount(input.amount, 'El importe');
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Indicá el motivo del movimiento');
    if (reason.length > 120) throw new BadRequestException('El motivo es demasiado largo (máximo 120 caracteres)');

    await this.prisma.cashMovement.create({
      data: { registerId, type: input.type, amount, reason, createdBy: actor.name },
    });
    return this.viewFor(await this.summarize(this.prisma, tenantId, registerId), actor.role);
  }

  /**
   * Cierra la caja: el sistema calcula el efectivo que debería haber, se compara con lo que el
   * cajero contó y se guarda la diferencia (arqueo). Una caja cerrada no se modifica.
   */
  async close(tenantId: string, actor: CashActor, input: { countedAmount: number; note?: string }) {
    const counted = this.cleanAmount(input.countedAmount, 'El efectivo contado', true);
    const note = (input.note ?? '').trim().slice(0, 300);

    const registerId = await this.prisma.$transaction(async (tx) => {
      const id = await this.requireOpenRegisterId(tx, tenantId);
      const summary = await this.summarize(tx, tenantId, id);
      const expected = summary.cash.expected;

      await tx.cashRegister.update({
        where: { id },
        data: {
          closedAt: new Date(),
          closedByName: actor.name,
          expectedAmount: expected,
          countedAmount: counted,
          difference: round2(counted - expected),
          note,
        },
      });
      const { count } = await tx.tenant.updateMany({ where: { id: tenantId, openRegisterId: id }, data: { openRegisterId: null } });
      if (count === 0) throw new ConflictException('La caja ya fue cerrada');
      return id;
    });
    return this.summarize(this.prisma, tenantId, registerId);
  }

  /** Historial de cajas (las más recientes primero). */
  async history(tenantId: string, limit = 60) {
    const registers = await this.prisma.cashRegister.findMany({
      where: { tenantId },
      orderBy: { openedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return registers.map((r) => ({
      id: r.id,
      openedAt: r.openedAt,
      openedByName: r.openedByName,
      closedAt: r.closedAt,
      closedByName: r.closedByName,
      openingAmount: r.openingAmount,
      expectedAmount: r.expectedAmount,
      countedAmount: r.countedAmount,
      difference: r.difference,
      note: r.note,
    }));
  }

  async detail(tenantId: string, id: string) {
    return this.summarize(this.prisma, tenantId, id);
  }

  // ---- cálculo del resumen ----

  /**
   * Conteo a ciegas: mientras la caja está abierta, quien no es administrador NO recibe nada con lo que
   * se pueda deducir el efectivo esperado (ni cobros en efectivo, ni el desglose por método, ni el
   * esperado). Se censura acá, en el servidor: ocultarlo solo en la pantalla no alcanza, porque la
   * respuesta de la API se puede leer. Al cerrar, el resumen completo es parte del resultado del arqueo.
   */
  private viewFor(summary: Awaited<ReturnType<CashService['summarize']>>, role: Role) {
    if (role === Role.ADMIN || !summary.open) return summary;
    return {
      ...summary,
      byMethod: [] as typeof summary.byMethod,
      cash: { opening: summary.cash.opening, sales: null as number | null, in: summary.cash.in, out: summary.cash.out, expected: null as number | null },
    };
  }

  private async summarize(db: Db, tenantId: string, registerId: string) {
    const register = await db.cashRegister.findFirst({
      where: { id: registerId, tenantId },
      include: { movements: { orderBy: { createdAt: 'asc' } } },
    });
    if (!register) throw new NotFoundException('Caja no encontrada');

    const sales = await db.sale.findMany({ where: { registerId, tenantId }, include: { payments: true } });

    const methods = new Map<string, { amount: number; count: number }>();
    const tips = new Map<string, number>();
    let cashSales = 0;
    for (const sale of sales) {
      if (sale.tipAmount > 0) tips.set(sale.waiterName, (tips.get(sale.waiterName) ?? 0) + sale.tipAmount);
      for (const p of sale.payments) {
        const row = methods.get(p.method) ?? { amount: 0, count: 0 };
        row.amount += p.amount;
        row.count += 1;
        methods.set(p.method, row);
        // Lo que entra al cajón es lo aplicado a la cuenta: el vuelto ya no está en el importe del pago
        if (p.method === 'efectivo') cashSales += p.amount;
      }
    }

    const cashIn = register.movements.filter((m) => m.type === 'IN').reduce((s, m) => s + m.amount, 0);
    const cashOut = register.movements.filter((m) => m.type === 'OUT').reduce((s, m) => s + m.amount, 0);
    const expected = round2(register.openingAmount + cashSales + cashIn - cashOut);

    return {
      id: register.id,
      open: register.closedAt === null,
      openedAt: register.openedAt,
      openedByName: register.openedByName,
      closedAt: register.closedAt,
      closedByName: register.closedByName,
      note: register.note,
      // al cerrar quedan guardados los valores del momento; mientras está abierta se calculan en vivo
      countedAmount: register.countedAmount,
      difference: register.difference,
      sales: {
        count: sales.length,
        totalAmount: round2(sales.reduce((s, x) => s + x.totalAmount, 0)),
        discountTotal: round2(sales.reduce((s, x) => s + x.discountTotal, 0)),
        tipsTotal: round2(sales.reduce((s, x) => s + x.tipAmount, 0)),
      },
      byMethod: [...methods.entries()]
        .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count }))
        .sort((a, b) => b.amount - a.amount),
      tipsByWaiter: [...tips.entries()].map(([waiterName, amount]) => ({ waiterName, amount: round2(amount) })).sort((a, b) => b.amount - a.amount),
      cash: {
        opening: register.openingAmount,
        sales: round2(cashSales),
        in: round2(cashIn),
        out: round2(cashOut),
        expected: register.closedAt ? (register.expectedAmount as number) : expected,
      },
      movements: register.movements.map((m) => ({
        id: m.id,
        type: m.type,
        amount: m.amount,
        reason: m.reason,
        createdBy: m.createdBy,
        createdAt: m.createdAt,
      })),
    };
  }

  private async requireOpenRegisterId(db: Db, tenantId: string): Promise<string> {
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.openRegisterId) throw new ConflictException('No hay una caja abierta');
    return tenant.openRegisterId;
  }

  private cleanAmount(value: unknown, label: string, allowZero = false): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n > MAX_AMOUNT || n < 0 || (!allowZero && n === 0)) {
      throw new BadRequestException(`${label} no es válido`);
    }
    return round2(n);
  }
}
