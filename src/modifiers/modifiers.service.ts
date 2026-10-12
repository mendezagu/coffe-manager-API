import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ModifierGroup, ModifierOption, ModifierSelection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OptionInput {
  id?: string; // si viene, se edita esa opción; si no, se crea
  name: string;
  priceDelta?: number;
  active?: boolean;
}

export interface GroupInput {
  name?: string;
  selection?: ModifierSelection;
  required?: boolean;
  options?: OptionInput[];
}

type GroupWithOptions = ModifierGroup & { options: ModifierOption[]; _count?: { items: number } };

export function mapModifierGroup(g: GroupWithOptions) {
  return {
    _id: g.id,
    name: g.name,
    selection: g.selection,
    required: g.required,
    position: g.position,
    options: [...g.options]
      .sort((a, b) => a.position - b.position)
      .map((o) => ({ _id: o.id, name: o.name, priceDelta: o.priceDelta, position: o.position, active: o.active })),
    ...(g._count && { itemsCount: g._count.items }),
  };
}

const MAX_PRICE_DELTA = 10_000_000;
const normalize = (name: string) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

const INCLUDE = {
  options: { orderBy: [{ position: 'asc' as const }, { name: 'asc' as const }] },
  _count: { select: { items: true } },
};

@Injectable()
export class ModifiersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const groups = await this.prisma.modifierGroup.findMany({
      where: { tenantId },
      include: INCLUDE,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return groups.map(mapModifierGroup);
  }

  async create(tenantId: string, input: GroupInput) {
    const name = this.cleanName(input.name);
    const options = this.cleanOptions(input.options);
    if (options.length === 0) throw new BadRequestException('Agregá al menos una opción');
    await this.assertNameAvailable(tenantId, name);

    try {
      const last = await this.prisma.modifierGroup.aggregate({ where: { tenantId }, _max: { position: true } });
      const group = await this.prisma.modifierGroup.create({
        data: {
          tenantId,
          name,
          selection: input.selection ?? ModifierSelection.SINGLE,
          required: input.required ?? false,
          position: (last._max.position ?? -1) + 1,
          options: {
            create: options.map((o, position) => ({ name: o.name, priceDelta: o.priceDelta, active: o.active, position })),
          },
        },
        include: INCLUDE,
      });
      return mapModifierGroup(group);
    } catch (error) {
      this.rethrowIfDuplicate(error);
      throw error;
    }
  }

  async update(tenantId: string, id: string, input: GroupInput) {
    const current = await this.prisma.modifierGroup.findFirst({ where: { id, tenantId }, include: { options: true } });
    if (!current) throw new NotFoundException('Modificador no encontrado');

    const name = input.name === undefined ? undefined : this.cleanName(input.name);
    if (name !== undefined) await this.assertNameAvailable(tenantId, name, id);

    // options viene como la lista completa y ordenada: las que ya no están se borran
    // (lo ya pedido no se ve afectado: las órdenes guardan su propia copia).
    const options = input.options === undefined ? undefined : this.cleanOptions(input.options);
    if (options) {
      if (options.length === 0) throw new BadRequestException('Agregá al menos una opción');
      const known = new Set(current.options.map((o) => o.id));
      if (options.some((o) => o.id && !known.has(o.id))) {
        throw new BadRequestException('Hay opciones que no pertenecen a este modificador');
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.modifierGroup.update({
          where: { id },
          data: { name, selection: input.selection, required: input.required },
        });
        if (!options) return;

        const keep = options.filter((o) => o.id).map((o) => o.id as string);
        await tx.modifierOption.deleteMany({ where: { groupId: id, id: { notIn: keep } } });
        for (const [position, o] of options.entries()) {
          const data = { name: o.name, priceDelta: o.priceDelta, active: o.active, position };
          if (o.id) await tx.modifierOption.update({ where: { id: o.id }, data });
          else await tx.modifierOption.create({ data: { ...data, groupId: id } });
        }
      });
    } catch (error) {
      this.rethrowIfDuplicate(error);
      throw error;
    }

    const group = await this.prisma.modifierGroup.findUnique({ where: { id }, include: INCLUDE });
    return mapModifierGroup(group as GroupWithOptions);
  }

  // Borrar un grupo lo quita de todos los platos; lo ya pedido conserva su copia.
  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    const { count } = await this.prisma.modifierGroup.deleteMany({ where: { id, tenantId } });
    if (count === 0) throw new NotFoundException('Modificador no encontrado');
    return { message: 'Modificador eliminado' };
  }

  async reorder(tenantId: string, ids: unknown) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('Se esperaba una lista de ids de modificadores');
    }
    await this.prisma.$transaction(
      (ids as string[]).map((id, position) =>
        this.prisma.modifierGroup.updateMany({ where: { id, tenantId }, data: { position } }),
      ),
    );
    return this.findAll(tenantId);
  }

  // Ofrece este grupo en todos los platos de una categoría (los que ya lo tenían no cambian)
  async applyToCategory(tenantId: string, groupId: string, categoryId: string) {
    const [group, category] = await Promise.all([
      this.prisma.modifierGroup.findFirst({ where: { id: groupId, tenantId } }),
      this.prisma.category.findFirst({ where: { id: categoryId, tenantId } }),
    ]);
    if (!group) throw new NotFoundException('Modificador no encontrado');
    if (!category) throw new NotFoundException('Categoría no encontrada');

    const items = await this.prisma.menuItem.findMany({ where: { tenantId, categoryId }, select: { id: true } });
    const { count } = await this.prisma.menuItemModifierGroup.createMany({
      data: items.map((i) => ({ menuItemId: i.id, groupId })),
      skipDuplicates: true,
    });
    return { assigned: count, categoryItems: items.length };
  }

  // ---- validaciones ----

  private cleanName(name: unknown): string {
    const cleaned = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!cleaned) throw new BadRequestException('El nombre es obligatorio');
    if (cleaned.length > 60) throw new BadRequestException('El nombre es demasiado largo (máximo 60 caracteres)');
    return cleaned;
  }

  private cleanOptions(options: OptionInput[] | undefined) {
    const list = (options ?? []).map((o) => {
      const name = this.cleanName(o.name);
      const priceDelta = o.priceDelta === undefined ? 0 : Number(o.priceDelta);
      if (!Number.isFinite(priceDelta) || Math.abs(priceDelta) > MAX_PRICE_DELTA) {
        throw new BadRequestException(`El precio de "${name}" no es válido`);
      }
      return { id: o.id, name, priceDelta: Math.round(priceDelta * 100) / 100, active: o.active ?? true };
    });
    if (list.length > 50) throw new BadRequestException('Un modificador admite hasta 50 opciones');
    const seen = new Set<string>();
    for (const o of list) {
      const key = normalize(o.name);
      if (seen.has(key)) throw new ConflictException(`La opción "${o.name}" está repetida`);
      seen.add(key);
    }
    return list;
  }

  private async assertNameAvailable(tenantId: string, name: string, excludeId?: string) {
    const target = normalize(name);
    const all = await this.prisma.modifierGroup.findMany({ where: { tenantId }, select: { id: true, name: true } });
    if (all.some((g) => g.id !== excludeId && normalize(g.name) === target)) {
      throw new ConflictException('Ya existe un modificador con ese nombre');
    }
  }

  private rethrowIfDuplicate(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe un modificador con ese nombre');
    }
  }
}
