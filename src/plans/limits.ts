import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PLAN_LABELS, PlanKey, PlanLimits, limitsOf } from './plans';

type Db = PrismaService | Prisma.TransactionClient;

// Qué se cuenta contra cada tope
export type LimitKind = 'tables' | 'menuItems' | 'users' | 'waiters' | 'counterSalesPerMonth' | 'onlineOrdersPerMonth';

const NOUN: Record<LimitKind, { one: string; many: string; per?: string }> = {
  tables: { one: 'mesa', many: 'mesas' },
  menuItems: { one: 'plato en el menú', many: 'platos en el menú' },
  users: { one: 'usuario', many: 'usuarios' },
  waiters: { one: 'mozo', many: 'mozos' },
  counterSalesPerMonth: { one: 'venta de mostrador', many: 'ventas de mostrador', per: 'por mes' },
  onlineOrdersPerMonth: { one: 'pedido de la tienda online', many: 'pedidos de la tienda online', per: 'por mes' },
};

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

async function countOf(db: Db, tenantId: string, kind: LimitKind): Promise<number> {
  switch (kind) {
    case 'tables':
      return db.table.count({ where: { tenantId } });
    case 'menuItems':
      return db.menuItem.count({ where: { tenantId } });
    case 'users':
      return db.user.count({ where: { tenantId, active: true } });
    case 'waiters':
      return db.waiter.count({ where: { tenantId } });
    case 'counterSalesPerMonth':
      return db.sale.count({ where: { tenantId, source: 'mostrador', date: { gte: monthStart() } } });
    case 'onlineOrdersPerMonth':
      return db.deliveryOrder.count({ where: { tenantId, createdAt: { gte: monthStart() } } });
  }
}

export function limitMessage(plan: string, kind: LimitKind, max: number): string {
  const n = NOUN[kind];
  const label = PLAN_LABELS[plan as PlanKey] ?? plan;
  if (max === 0) return `Tu plan ${label} no incluye ${n.many}. Pasá a un plan pago para usarlos.`;
  return `Llegaste al límite de tu plan ${label}: hasta ${max} ${max === 1 ? n.one : n.many}${n.per ? ' ' + n.per : ''}. Pasá a un plan pago para sumar más.`;
}

// Corta si agregar uno más pasaría el tope del plan. Sin tope (planes pagos) no hace nada ni consulta la base.
export async function assertWithinLimit(db: Db, tenantId: string, kind: LimitKind, opts: { publicFacing?: boolean; adding?: number } = {}): Promise<void> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, addons: true } });
  if (!tenant) return;
  const max = limitsOf(tenant)[kind];
  if (max === undefined) return;
  // `adding` > 1: altas de a varias (por ejemplo, crear 8 mesas juntas): tienen que entrar todas
  if ((await countOf(db, tenantId, kind)) + (opts.adding ?? 1) <= max) return;
  // Quien pide desde la carta pública no tiene que enterarse del plan del local
  if (opts.publicFacing) throw new ConflictException('La tienda no está recibiendo pedidos en este momento');
  throw new ForbiddenException(limitMessage(tenant.plan, kind, max));
}

export interface UsageRow {
  used: number;
  max: number;
}
export type PlanUsage = Partial<Record<LimitKind, UsageRow>> & { historyDays?: number };

// Cuánto usa el negocio de cada tope de su plan (para los avisos "Usás 4 de 5 mesas")
export async function usageOf(db: Db, tenantId: string): Promise<PlanUsage> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, addons: true } });
  if (!tenant) return {};
  const limits: PlanLimits = limitsOf(tenant);
  const out: PlanUsage = {};
  for (const kind of Object.keys(NOUN) as LimitKind[]) {
    const max = limits[kind];
    if (max === undefined) continue;
    out[kind] = { used: await countOf(db, tenantId, kind), max };
  }
  if (limits.historyDays !== undefined) out.historyDays = limits.historyDays;
  return out;
}
