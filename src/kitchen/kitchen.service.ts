import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// Las líneas ya listas se muestran un rato (para poder deshacer un error) y después salen del tablero.
const READY_VISIBLE_MS = 60 * 60 * 1000;

@Injectable()
export class KitchenService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string) {
    const since = new Date(Date.now() - READY_VISIBLE_MS);
    const orders = await this.prisma.order.findMany({
      where: {
        table: { tenantId },
        OR: [{ status: { in: ['PENDING', 'PREPARING'] } }, { status: 'READY', updatedAt: { gte: since } }],
      },
      include: { menuItem: true, table: { include: { waiter: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return orders.map((o) => ({
      id: o.id,
      tableId: o.tableId,
      tableName: o.table.name,
      waiterName: o.table.waiter?.name ?? null,
      itemName: o.menuItem?.name ?? 'Ítem eliminado',
      quantity: o.quantity,
      note: o.note,
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));
  }

  async setStatus(tenantId: string, id: string, status: OrderStatus) {
    const order = await this.prisma.order.findFirst({ where: { id, table: { tenantId } } });
    if (!order) throw new NotFoundException('Orden no encontrada');
    await this.prisma.order.update({ where: { id }, data: { status } });
    return { id, status };
  }

  async setManyStatus(tenantId: string, ids: string[], status: OrderStatus) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: { in: ids }, table: { tenantId } },
      data: { status },
    });
    return { updated: count, status };
  }
}
