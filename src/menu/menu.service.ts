import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapMenuItem } from '../common/mappers';
import { availableStock, committedConsumption, loadContext, maxUnits } from '../inventory/inventory.logic';
import { BADGE_MAX, DESCRIPTION_MAX, cleanText, pickBadgeColor } from '../common/menu-fields';

export const MENU_INCLUDE = {
  modifierGroups: { select: { groupId: true }, orderBy: { position: 'asc' as const } },
  optionPrices: { select: { optionId: true, price: true } },
};
const WITH_GROUPS = MENU_INCLUDE;
const MAX_PRICE = 100_000_000;
const norm = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/s+/g, ' ').trim().toLowerCase();

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
    const optionPrices = await this.resolveOptionPrices(tenantId, groupIds ?? [], createMenuItemDto.optionPrices);

    const item = await this.prisma.menuItem.create({
      data: {
        tenantId,
        name: createMenuItemDto.name,
        price: createMenuItemDto.price,
        quantity: createMenuItemDto.quantity ?? 1,
        isPromo: createMenuItemDto.isPromo ?? false,
        description: cleanText(createMenuItemDto.description, DESCRIPTION_MAX, 'La descripción') ?? null,
        badge: cleanText(createMenuItemDto.badge, BADGE_MAX, 'La etiqueta') ?? null,
        badgeColor: pickBadgeColor(createMenuItemDto.badgeColor),
        featured: createMenuItemDto.featured === true,
        visibleInMenu: createMenuItemDto.visibleInMenu !== false,
        categoryId,
        modifierGroups: groupIds ? { create: groupIds.map((groupId, position) => ({ groupId, position })) } : undefined,
        optionPrices: optionPrices?.length ? { create: optionPrices } : undefined,
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
    // optionPrices: undefined = no tocar (salvo quitar los de grupos que el plato ya no ofrece); objeto = esos son los precios propios
    const offeredIds = groupIds ?? (await this.prisma.menuItemModifierGroup.findMany({ where: { menuItemId: id, menuItem: { tenantId } }, select: { groupId: true } })).map((g) => g.groupId);
    const optionPrices = await this.resolveOptionPrices(tenantId, offeredIds, updateMenuItemDto.optionPrices);
    try {
      const item = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.menuItem.update({
          where: { id, tenantId },
          data: {
            name: updateMenuItemDto.name,
            price: updateMenuItemDto.price,
            // undefined = Prisma no toca la columna (ediciones parciales)
            isPromo: updateMenuItemDto.isPromo,
            description: cleanText(updateMenuItemDto.description, DESCRIPTION_MAX, 'La descripción'),
            badge: cleanText(updateMenuItemDto.badge, BADGE_MAX, 'La etiqueta'),
            badgeColor: pickBadgeColor(updateMenuItemDto.badgeColor),
            featured: typeof updateMenuItemDto.featured === 'boolean' ? updateMenuItemDto.featured : undefined,
            visibleInMenu: typeof updateMenuItemDto.visibleInMenu === 'boolean' ? updateMenuItemDto.visibleInMenu : undefined,
            isFavorite: typeof updateMenuItemDto.isFavorite === 'boolean' ? updateMenuItemDto.isFavorite : undefined,
            categoryId,
            // si lo editó, deja de ser un plato de ejemplo
            isExample: false,
          },
        });
        if (groupIds) {
          await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId: id } });
          await tx.menuItemModifierGroup.createMany({
            data: groupIds.map((groupId, position) => ({ menuItemId: id, groupId, position })),
          });
        }
        if (optionPrices) {
          await tx.menuItemOptionPrice.deleteMany({ where: { menuItemId: id } });
          await tx.menuItemOptionPrice.createMany({ data: optionPrices.map((p) => ({ menuItemId: id, ...p })) });
        } else if (groupIds) {
          // si dejó de ofrecer un grupo, sus precios propios ya no valen
          await tx.menuItemOptionPrice.deleteMany({ where: { menuItemId: id, option: { groupId: { notIn: groupIds } } } });
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

  // Precios propios por opción: { idOpción: precio final del plato con esa opción }.
  // Solo valen para grupos de "una opción" y obligatorios (el tamaño) que el plato ofrece.
  // undefined si no vino el campo; si vino, la lista validada (las opciones ya no ofrecidas se descartan al guardar).
  private async resolveOptionPrices(tenantId: string, offeredGroupIds: string[], raw: unknown): Promise<{ optionId: string; price: number }[] | undefined> {
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Los precios por opción no son válidos');
    const entries = Object.entries(raw as Record<string, unknown>);
    if (entries.length === 0) return [];
    const options = await this.prisma.modifierOption.findMany({
      where: { id: { in: entries.map(([id]) => id) }, group: { tenantId, id: { in: offeredGroupIds }, required: true, selection: 'SINGLE' } },
      select: { id: true },
    });
    const valid = new Set(options.map((o) => o.id));
    const out: { optionId: string; price: number }[] = [];
    for (const [optionId, value] of entries) {
      if (value === null || value === '') continue; // vacío = sin precio propio
      const price = Number(value);
      if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) throw new BadRequestException('Hay un precio por opción que no es válido');
      if (!valid.has(optionId)) throw new BadRequestException('Hay un precio para una opción que el plato no ofrece');
      out.push({ optionId, price: Math.round(price * 100) / 100 });
    }
    return out;
  }

  /**
   * Carga una planilla de platos con precio por tamaño (Chico / Jarro / Doble…).
   * Crea el grupo de tamaños si falta, crea los platos nuevos y actualiza los que ya existen (por nombre).
   * Un plato con un solo precio queda con precio simple; con varios, ofrece los tamaños que tienen precio.
   */
  async importSizes(tenantId: string, dto: any) {
    const groupName = String(dto?.groupName ?? 'Tamaño').trim().slice(0, 60) || 'Tamaño';
    const sizes: string[] = Array.isArray(dto?.sizes) ? dto.sizes.map((x: unknown) => String(x ?? '').trim()) : [];
    const rows: any[] = Array.isArray(dto?.rows) ? dto.rows : [];
    if (sizes.length < 1 || sizes.length > 12 || sizes.some((x) => !x || x.length > 60) || new Set(sizes.map(norm)).size !== sizes.length) {
      throw new BadRequestException('Los tamaños no son válidos: hasta 12, sin nombres vacíos ni repetidos');
    }
    if (rows.length === 0) throw new BadRequestException('La planilla no tiene platos');
    if (rows.length > 500) throw new BadRequestException('Son demasiados platos de una vez (máximo 500)');

    const clean = rows.map((r, i) => {
      const name = String(r?.name ?? '').trim();
      if (!name || name.length > 120) throw new BadRequestException(`La fila ${i + 1} no tiene un nombre válido`);
      const prices = sizes.map((_, k) => {
        const v = r?.prices?.[k];
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) throw new BadRequestException(`"${name}": hay un precio que no es válido`);
        return Math.round(n * 100) / 100;
      });
      if (prices.every((p) => p === null)) throw new BadRequestException(`"${name}" no tiene ningún precio`);
      const category = String(r?.category ?? '').trim().slice(0, 60);
      return { name, prices, category };
    });

    return this.prisma.$transaction(async (tx) => {
      // grupo de tamaños: se reutiliza si ya existe (por nombre, sin tildes ni mayúsculas)
      const groups = await tx.modifierGroup.findMany({ where: { tenantId }, include: { options: true } });
      let group = groups.find((g) => norm(g.name) === norm(groupName));
      if (!group) {
        group = await tx.modifierGroup.create({ data: { tenantId, name: groupName, selection: 'SINGLE', required: true, position: groups.length }, include: { options: true } });
      } else if (group.selection !== 'SINGLE' || !group.required) {
        throw new BadRequestException(`"${group.name}" ya existe pero no es de una sola opción obligatoria. Usá otro nombre.`);
      }
      const optionIds: string[] = [];
      for (const [position, label] of sizes.entries()) {
        const found = group.options.find((o) => norm(o.name) === norm(label));
        const option = found
          ? await tx.modifierOption.update({ where: { id: found.id }, data: { active: true, position } })
          : await tx.modifierOption.create({ data: { groupId: group.id, name: label, position, priceDelta: 0 } });
        optionIds.push(option.id);
      }

      const existing = await tx.menuItem.findMany({ where: { tenantId }, select: { id: true, name: true } });
      const byName = new Map(existing.map((i) => [norm(i.name), i.id]));
      const categories = await tx.category.findMany({ where: { tenantId } });
      const catByName = new Map(categories.map((c) => [norm(c.name), c.id]));
      let created = 0;
      let updated = 0;

      for (const row of clean) {
        let categoryId: string | undefined;
        if (row.category) {
          categoryId = catByName.get(norm(row.category));
          if (!categoryId) {
            categoryId = (await tx.category.create({ data: { tenantId, name: row.category, position: catByName.size } })).id;
            catByName.set(norm(row.category), categoryId);
          }
        }
        const given = row.prices.map((p, k) => ({ p, k })).filter((x): x is { p: number; k: number } => x.p !== null);
        const base = Math.min(...given.map((x) => x.p));

        let id = byName.get(norm(row.name));
        if (id) {
          await tx.menuItem.update({ where: { id }, data: { price: base, isExample: false, ...(categoryId && { categoryId }) } });
          updated++;
        } else {
          id = (await tx.menuItem.create({ data: { tenantId, name: row.name, price: base, categoryId } })).id;
          byName.set(norm(row.name), id);
          created++;
        }

        // los precios propios de este grupo se reemplazan por los de la planilla
        await tx.menuItemOptionPrice.deleteMany({ where: { menuItemId: id, option: { groupId: group.id } } });
        if (given.length > 1) {
          await tx.menuItemOptionPrice.createMany({ data: given.map(({ p, k }) => ({ menuItemId: id!, optionId: optionIds[k], price: p })) });
          const linked = await tx.menuItemModifierGroup.findUnique({ where: { menuItemId_groupId: { menuItemId: id, groupId: group.id } } });
          if (!linked) {
            const count = await tx.menuItemModifierGroup.count({ where: { menuItemId: id } });
            await tx.menuItemModifierGroup.create({ data: { menuItemId: id, groupId: group.id, position: count } });
          }
        } else {
          // un solo precio: el plato no tiene tamaños
          await tx.menuItemModifierGroup.deleteMany({ where: { menuItemId: id, groupId: group.id } });
        }
      }
      return { created, updated, total: clean.length, groupName: group.name };
    });
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    // deleteMany no falla si no existe: el mensaje se devuelve igual, como antes
    await this.prisma.menuItem.deleteMany({ where: { id, tenantId } });
    return { message: 'Ítem eliminado' };
  }
}
