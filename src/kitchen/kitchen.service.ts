import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Destination, OrderStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../plans/plans';
import { readSnapshot } from '../modifiers/modifiers.logic';

// Las líneas ya listas se muestran un rato (para poder deshacer un error) y después salen del tablero.
const READY_VISIBLE_MS = 60 * 60 * 1000;

const LINE_INCLUDE = { menuItem: { include: { category: true } }, table: { include: { waiter: true } } } as const;

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * El negocio separa cocina y barra solo si lo activó Y su plan lo incluye.
   * Sin separación todo va a cocina (un plato sin categoría también va a cocina).
   */
  async isSplit(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    return !!tenant && tenant.kitchenEnabled && tenant.splitKitchenBar && hasFeature(tenant.plan, 'kitchen_bar_split');
  }

  // La cocina es opcional: si el negocio no la habilitó en "Mi negocio", no hay pantalla ni estados de pedido.
  private async assertEnabled(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant?.kitchenEnabled) {
      throw new ForbiddenException('La cocina no está habilitada en este negocio. Se activa en "Mi negocio".');
    }
  }

  private destinationOf(line: { menuItem: { category: { destination: Destination } | null } | null }): Destination {
    return line.menuItem?.category?.destination ?? Destination.KITCHEN;
  }

  // ¿Esta persona puede ver/mover una línea con ese destino?
  private canHandle(role: Role, split: boolean, destination: Destination): boolean {
    if (role === Role.ADMIN) return true;
    if (!split) return role === Role.KITCHEN; // sin separación, la barra no tiene pantalla propia
    return role === Role.KITCHEN ? destination === Destination.KITCHEN : destination === Destination.BAR;
  }

  async list(tenantId: string, role: Role, requested?: Destination) {
    await this.assertEnabled(tenantId);
    const split = await this.isSplit(tenantId);
    const since = new Date(Date.now() - READY_VISIBLE_MS);
    const orders = await this.prisma.order.findMany({
      where: {
        table: { tenantId },
        OR: [{ status: { in: ['PENDING', 'PREPARING'] } }, { status: 'READY', updatedAt: { gte: since } }],
      },
      include: LINE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return orders
      .map((o) => ({ order: o, destination: this.destinationOf(o) }))
      // el admin puede filtrar por pestaña (solo tiene sentido si hay separación)
      .filter(({ destination }) => this.canHandle(role, split, destination) && (!split || !requested || role !== Role.ADMIN || destination === requested))
      .map(({ order: o, destination }) => ({
        id: o.id,
        tableId: o.tableId,
        tableName: o.table.name,
        waiterName: o.table.waiter?.name ?? null,
        itemName: o.menuItem?.name ?? 'Ítem eliminado',
        quantity: o.quantity,
        note: o.note,
        // opciones elegidas (ej: "Grande", "Leche de almendras"), en el orden de los grupos
        modifiers: readSnapshot(o.modifiers).map((m) => m.name),
        status: o.status,
        destination,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      }));
  }

  async setStatus(tenantId: string, role: Role, id: string, status: OrderStatus) {
    await this.assertEnabled(tenantId);
    const order = await this.prisma.order.findFirst({ where: { id, table: { tenantId } }, include: LINE_INCLUDE });
    if (!order) throw new NotFoundException('Orden no encontrada');
    if (!this.canHandle(role, await this.isSplit(tenantId), this.destinationOf(order))) {
      throw new ForbiddenException('Ese pedido no es de tu sector');
    }
    await this.prisma.order.update({ where: { id }, data: { status } });
    return { id, status };
  }

  async setManyStatus(tenantId: string, role: Role, ids: string[], status: OrderStatus) {
    await this.assertEnabled(tenantId);
    const [orders, split] = await Promise.all([
      this.prisma.order.findMany({ where: { id: { in: ids }, table: { tenantId } }, include: LINE_INCLUDE }),
      this.isSplit(tenantId),
    ]);
    // Se mueven solo las líneas de su sector; las ajenas se ignoran
    const allowed = orders.filter((o) => this.canHandle(role, split, this.destinationOf(o))).map((o) => o.id);
    const { count } = await this.prisma.order.updateMany({ where: { id: { in: allowed } }, data: { status } });
    return { updated: count, status };
  }
}
