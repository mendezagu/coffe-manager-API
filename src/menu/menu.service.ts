import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapMenuItem } from '../common/mappers';
import { availableStock, committedConsumption, loadContext, maxUnits } from '../inventory/inventory.logic';

const WITH_GROUPS = { modifierGroups: { select: { groupId: true }, orderBy: { position: 'asc' as const } } };

@Injectable()
export class MenuService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const [items, tenant] = await Promise.all([
      this.prisma.menuItem.findMany({ where: { tenantId }, include: WITH_GROUPS }),
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
    ]);

    // Con inventario activo, cada plato con receta informa cuántas unidades se pueden preparar
    // (null = sin receta: no se controla). El mozo lo usa para marcar "Agotado".
    let availableUnits: (id: string) => number | null = () => null;
    if (tenant?.inventoryEnabled) {
      const ctx = await loadContext(this.prisma, tenantId);
      const avail = availableStock(ctx, await committedConsumption(this.prisma, tenantId, ctx));
      availableUnits = (id) => maxUnits(ctx, avail, id);
    }
    return items.map((item) => ({ ...mapMenuItem(item), availableUnits: availableUnits(item.id) }));
  }

  async create(tenantId: string, createMenuItemDto: any) {
    const categoryId = (await this.resolveCategoryId(tenantId, createMenuItemDto.categoryId)) ?? null;
    const groupIds = await this.resolveGroupIds(tenantId, createMenuItemDto.modifierGroupIds);

    const item = await this.prisma.menuItem.create({
      data: {
        tenantId,
        name: createMenuItemDto.name,
        price: createMenuItemDto.price,
        quantity: createMenuItemDto.quantity ?? 1,
        isPromo: createMenuItemDto.isPromo ?? false,
        categoryId,
        modifierGroups: groupIds ? { create: groupIds.map((groupId, position) => ({ groupId, position })) } : undefined,
      },
      include: WITH_GROUPS,
    });
    return mapMenuItem(item);
  }

  async update(tenantId: string, id: string, updateMenuItemDto: any) {
    // categoryId: undefined = no tocar, null/'' = quitar la categoría, id = asignarla
    const categoryId = await this.resolveCategoryId(tenantId, updateMenuItemDto.categoryId);
    // modifierGroupIds: undefined = no tocar; lista = esos son los modificadores que ofrece el plato
    const groupIds = await this.resolveGroupIds(tenantId, updateMenuItemDto.modifierGroupIds);
    try {
      const item = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.menuItem.update({
          where: { id, tenantId },
          data: {
            name: updateMenuItemDto.name,
            price: updateMenuItemDto.price,
            // undefined = Prisma no toca la columna (ediciones parciales)
            isPromo: updateMenuItemDto.isPromo,
            categoryId,
          },
        });
        if (groupIds) {
          await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId: id } });
          await tx.menuItemModifierGroup.createMany({
            data: groupIds.map((groupId, position) => ({ menuItemId: id, groupId, position })),
          });
        }
        return tx.menuItem.findUniqueOrThrow({ where: { id: updated.id }, include: WITH_GROUPS });
      });
      return mapMenuItem(item);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        // Igual que antes: findByIdAndUpdate de Mongoose no tira 404, devuelve null
        return null;
      }
      throw error;
    }
  }

  // undefined si no vino el campo, null para quitarla, o el id validado (debe ser del mismo negocio)
  private async resolveCategoryId(tenantId: string, categoryId: unknown): Promise<string | null | undefined> {
    if (categoryId === undefined) return undefined;
    if (categoryId === null || categoryId === '') return null;
    const category = await this.prisma.category.findFirst({ where: { id: String(categoryId), tenantId } });
    if (!category) throw new NotFoundException('Categoría no encontrada');
    return category.id;
  }

  // undefined si no vino; si vino una lista, devuelve los ids sin repetir y validados (del mismo negocio)
  private async resolveGroupIds(tenantId: string, groupIds: unknown): Promise<string[] | undefined> {
    if (groupIds === undefined) return undefined;
    const ids = Array.isArray(groupIds) ? [...new Set(groupIds.filter((g): g is string => typeof g === 'string'))] : [];
    if (ids.length === 0) return [];
    const found = await this.prisma.modifierGroup.count({ where: { id: { in: ids }, tenantId } });
    if (found !== ids.length) throw new NotFoundException('Modificador no encontrado');
    return ids;
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    // deleteMany no falla si no existe: el mensaje se devuelve igual, como antes
    await this.prisma.menuItem.deleteMany({ where: { id, tenantId } });
    return { message: 'Ítem eliminado' };
  }
}
