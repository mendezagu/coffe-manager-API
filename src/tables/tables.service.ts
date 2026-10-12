import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapTable, mapWaiter } from '../common/mappers';

const ORDERS_IN_ORDER = { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] };
const FULL_INCLUDE = { orders: ORDERS_IN_ORDER, waiter: true, linkedTables: true, sector: true } as const;
const POPULATED_INCLUDE = {
  orders: { include: { menuItem: true }, ...ORDERS_IN_ORDER },
  waiter: true,
  linkedTables: true,
  sector: true,
} as const;

function isNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

@Injectable()
export class TablesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const tables = await this.prisma.table.findMany({ include: FULL_INCLUDE, orderBy: { seq: 'asc' } });
    return tables.map(t => mapTable(t, { populateOrders: false }));
  }

  async findOne(id: string) {
    const table = await this.prisma.table.findUnique({ where: { id }, include: POPULATED_INCLUDE });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return mapTable(table, { populateOrders: true });
  }

  async create(createTableDto: any) {
    const sectorId = await this.resolveSectorId(createTableDto.sectorId);
    const table = await this.prisma.table.create({
      data: {
        name: createTableDto.name,
        available: createTableDto.available ?? true,
        sectorId: sectorId ?? null,
      },
      include: { sector: true },
    });
    return mapTable(table, { populateOrders: false });
  }

  async update(id: string, updateTableDto: any) {
    // sectorId: undefined = no tocar, null/'' = quitar el sector, id = asignar ese sector
    const sectorId = await this.resolveSectorId(updateTableDto.sectorId);
    try {
      const table = await this.prisma.table.update({
        where: { id },
        data: {
          name: updateTableDto.name,
          available: updateTableDto.available,
          sectorId,
        },
        include: FULL_INCLUDE,
      });
      return mapTable(table, { populateOrders: false });
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundException('Mesa no encontrada');
      }
      throw error;
    }
  }

  // Devuelve undefined si no vino el campo, null si se quiere quitar el sector, o el id validado.
  private async resolveSectorId(sectorId: unknown): Promise<string | null | undefined> {
    if (sectorId === undefined) return undefined;
    if (sectorId === null || sectorId === '') return null;
    const sector = await this.prisma.sector.findUnique({ where: { id: String(sectorId) } });
    if (!sector) {
      throw new NotFoundException('Sector no encontrado');
    }
    return sector.id;
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      await this.prisma.table.delete({ where: { id } });
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundException('Mesa no encontrada');
      }
      throw error;
    }
    return { message: 'Mesa eliminada' };
  }

  async addItems(id: string, items: any[]) {
    const table = await this.prisma.table.findUnique({ where: { id }, include: { orders: true } });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    await this.prisma.$transaction(async tx => {
      for (const item of items) {
        const menuItem = await tx.menuItem.findUnique({ where: { id: item.id } });
        if (!menuItem) {
          throw new NotFoundException(`Ítem con ID ${item.id} no encontrado`);
        }

        const note = (item.note || '').trim();

        // Los ítems con nota nunca se fusionan con una línea existente: cada
        // aclaración (ej. "sin verduras") debe quedar en su propia línea. Tampoco se suma a
        // una línea que cocina ya tomó: lo nuevo es una línea aparte, pendiente.
        const existingOrder = !note
          ? await tx.order.findFirst({ where: { tableId: id, menuItemId: item.id, note: '', status: 'PENDING' } })
          : undefined;

        if (existingOrder) {
          await tx.order.update({
            where: { id: existingOrder.id },
            data: { quantity: existingOrder.quantity + (item.quantity || 1) },
          });
        } else {
          await tx.order.create({
            data: {
              tableId: id,
              menuItemId: item.id,
              quantity: item.quantity || 1,
              note,
            },
          });
        }
      }
    });

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: POPULATED_INCLUDE });
    return mapTable(updatedTable, { populateOrders: true });
  }

  async getWaiterByName(name: string) {
    const waiter = await this.prisma.waiter.findFirst({ where: { name } });
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return mapWaiter(waiter);
  }

  async getWaiterById(id: string) {
    const waiter = await this.prisma.waiter.findUnique({ where: { id } });
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return mapWaiter(waiter);
  }

  async assignWaiter(id: string, waiterId: string, _waiterName: string) {
    try {
      const table = await this.prisma.table.update({
        where: { id },
        data: { waiterId },
        include: FULL_INCLUDE,
      });
      return { message: 'Mozo asignado correctamente', table: mapTable(table, { populateOrders: false }) };
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new NotFoundException('Mesa no encontrada');
      }
      throw error;
    }
  }

  async linkTables(id: string, linkedTableIds: string[]) {
    const parent = await this.prisma.table.findUnique({ where: { id } });
    if (!parent) {
      throw new NotFoundException('Mesa no encontrada');
    }

    await this.prisma.$transaction(async tx => {
      for (const linkedTableId of linkedTableIds) {
        const linkedTable = await tx.table.findUnique({ where: { id: linkedTableId } });
        if (!linkedTable) {
          throw new NotFoundException(`Mesa con ID ${linkedTableId} no encontrada`);
        }
        await tx.table.update({
          where: { id: linkedTableId },
          data: { controlledById: id, available: false },
        });
      }
    });

    const table = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Mesas vinculadas correctamente', table: mapTable(table, { populateOrders: false }) };
  }

  async unlinkTables(id: string, linkedTableIds: string[]) {
    const parent = await this.prisma.table.findUnique({ where: { id } });
    if (!parent) {
      throw new NotFoundException('Mesa no encontrada');
    }

    // updateMany, no unmatched ids son ignorados en silencio (asimetría real con linkTables)
    await this.prisma.table.updateMany({
      where: { id: { in: linkedTableIds } },
      data: { controlledById: null, available: true },
    });

    const table = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Mesas desvinculadas correctamente', table: mapTable(table, { populateOrders: false }) };
  }

  async updateOrderQuantities(id: string, updates: { orderId: string; quantity: number }[]) {
    const table = await this.prisma.table.findUnique({ where: { id } });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    for (const { orderId, quantity } of updates) {
      // updateMany + tableId en el where: ids que no matchean (o pertenecen a otra mesa) se ignoran en silencio
      await this.prisma.order.updateMany({
        where: { id: orderId, tableId: id },
        data: { quantity },
      });
    }

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: POPULATED_INCLUDE });
    return mapTable(updatedTable, { populateOrders: true });
  }

  async removeOrder(id: string, orderIds: string[]) {
    const table = await this.prisma.table.findUnique({ where: { id } });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    await this.prisma.order.deleteMany({
      where: { id: { in: orderIds }, tableId: id },
    });

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Órdenes eliminadas correctamente', table: mapTable(updatedTable, { populateOrders: false }) };
  }

  async resetTable(id: string) {
    const table = await this.prisma.table.findUnique({ where: { id } });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }

    await this.prisma.$transaction([
      this.prisma.order.deleteMany({ where: { tableId: id } }),
      this.prisma.table.updateMany({
        where: { controlledById: id },
        data: { controlledById: null, available: true },
      }),
      this.prisma.table.update({
        where: { id },
        data: { available: true, waiterId: null },
      }),
    ]);

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Mesa reseteada correctamente', table: mapTable(updatedTable, { populateOrders: false }) };
  }
}
