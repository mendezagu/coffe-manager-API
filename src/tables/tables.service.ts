import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapTable, mapWaiter } from '../common/mappers';
import { modifiersKey, resolveModifiers } from '../modifiers/modifiers.logic';

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

// Todos los métodos reciben el tenantId (negocio) del usuario y solo ven/tocan lo suyo.
@Injectable()
export class TablesService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const tables = await this.prisma.table.findMany({
      where: { tenantId },
      include: FULL_INCLUDE,
      orderBy: { seq: 'asc' },
    });
    return tables.map(t => mapTable(t, { populateOrders: false }));
  }

  async findOne(tenantId: string, id: string) {
    const table = await this.prisma.table.findFirst({ where: { id, tenantId }, include: POPULATED_INCLUDE });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return mapTable(table, { populateOrders: true });
  }

  async create(tenantId: string, createTableDto: any) {
    const sectorId = await this.resolveSectorId(tenantId, createTableDto.sectorId);
    const table = await this.prisma.table.create({
      data: {
        tenantId,
        name: createTableDto.name,
        available: createTableDto.available ?? true,
        sectorId: sectorId ?? null,
      },
      include: { sector: true },
    });
    return mapTable(table, { populateOrders: false });
  }

  async update(tenantId: string, id: string, updateTableDto: any) {
    // sectorId: undefined = no tocar, null/'' = quitar el sector, id = asignar ese sector
    const sectorId = await this.resolveSectorId(tenantId, updateTableDto.sectorId);
    try {
      const table = await this.prisma.table.update({
        where: { id, tenantId },
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
  private async resolveSectorId(tenantId: string, sectorId: unknown): Promise<string | null | undefined> {
    if (sectorId === undefined) return undefined;
    if (sectorId === null || sectorId === '') return null;
    const sector = await this.prisma.sector.findFirst({ where: { id: String(sectorId), tenantId } });
    if (!sector) {
      throw new NotFoundException('Sector no encontrado');
    }
    return sector.id;
  }

  // Confirma que la mesa existe y es del negocio; si no, 404 (no se distingue "de otro negocio").
  private async requireTable(tenantId: string, id: string) {
    const table = await this.prisma.table.findFirst({ where: { id, tenantId } });
    if (!table) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return table;
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    const { count } = await this.prisma.table.deleteMany({ where: { id, tenantId } });
    if (count === 0) {
      throw new NotFoundException('Mesa no encontrada');
    }
    return { message: 'Mesa eliminada' };
  }

  async addItems(tenantId: string, id: string, items: any[]) {
    await this.requireTable(tenantId, id);

    await this.prisma.$transaction(async tx => {
      for (const item of items) {
        const menuItem = await tx.menuItem.findFirst({ where: { id: item.id, tenantId } });
        if (!menuItem) {
          throw new NotFoundException(`Ítem con ID ${item.id} no encontrado`);
        }

        const note = (item.note || '').trim();
        // Opciones elegidas (ids): se validan contra lo que el plato ofrece y se guarda una copia
        // con el nombre y el precio de este momento.
        const modifiers = await resolveModifiers(tx, tenantId, menuItem.id, menuItem.name, item.modifiers);

        // Los ítems con nota nunca se fusionan con una línea existente: cada
        // aclaración (ej. "sin verduras") debe quedar en su propia línea. Tampoco se suma a
        // una línea que cocina ya tomó: lo nuevo es una línea aparte, pendiente.
        // Solo se fusionan líneas con las mismas opciones: un café grande y uno chico son líneas distintas.
        const sameItemLines = !note
          ? await tx.order.findMany({ where: { tableId: id, menuItemId: item.id, note: '', status: 'PENDING' } })
          : [];
        const existingOrder = sameItemLines.find((o) => modifiersKey(o.modifiers) === modifiersKey(modifiers));

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
              modifiers: modifiers as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }
    });

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: POPULATED_INCLUDE });
    return mapTable(updatedTable, { populateOrders: true });
  }

  async getWaiterByName(tenantId: string, name: string) {
    const waiter = await this.prisma.waiter.findFirst({ where: { name, tenantId } });
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return mapWaiter(waiter);
  }

  async getWaiterById(tenantId: string, id: string) {
    const waiter = await this.prisma.waiter.findFirst({ where: { id, tenantId } });
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }
    return mapWaiter(waiter);
  }

  async assignWaiter(tenantId: string, id: string, waiterId: string, _waiterName: string) {
    await this.requireTable(tenantId, id);
    const waiter = await this.prisma.waiter.findFirst({ where: { id: waiterId, tenantId } });
    if (!waiter) {
      throw new NotFoundException('Mozo no encontrado');
    }

    const table = await this.prisma.table.update({
      where: { id },
      data: { waiterId },
      include: FULL_INCLUDE,
    });
    return { message: 'Mozo asignado correctamente', table: mapTable(table, { populateOrders: false }) };
  }

  async linkTables(tenantId: string, id: string, linkedTableIds: string[]) {
    await this.requireTable(tenantId, id);

    await this.prisma.$transaction(async tx => {
      for (const linkedTableId of linkedTableIds) {
        const linkedTable = await tx.table.findFirst({ where: { id: linkedTableId, tenantId } });
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

  async unlinkTables(tenantId: string, id: string, linkedTableIds: string[]) {
    await this.requireTable(tenantId, id);

    // updateMany, no unmatched ids son ignorados en silencio (asimetría real con linkTables)
    await this.prisma.table.updateMany({
      where: { id: { in: linkedTableIds }, tenantId },
      data: { controlledById: null, available: true },
    });

    const table = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Mesas desvinculadas correctamente', table: mapTable(table, { populateOrders: false }) };
  }

  async updateOrderQuantities(tenantId: string, id: string, updates: { orderId: string; quantity: number }[]) {
    await this.requireTable(tenantId, id);

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

  async removeOrder(tenantId: string, id: string, orderIds: string[]) {
    await this.requireTable(tenantId, id);

    await this.prisma.order.deleteMany({
      where: { id: { in: orderIds }, tableId: id },
    });

    const updatedTable = await this.prisma.table.findUnique({ where: { id }, include: FULL_INCLUDE });
    return { message: 'Órdenes eliminadas correctamente', table: mapTable(updatedTable, { populateOrders: false }) };
  }

  async resetTable(tenantId: string, id: string) {
    await this.requireTable(tenantId, id);

    await this.prisma.$transaction([
      this.prisma.order.deleteMany({ where: { tableId: id } }),
      this.prisma.table.updateMany({
        where: { controlledById: id, tenantId },
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
