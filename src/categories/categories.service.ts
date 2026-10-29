import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Category, Destination, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FEATURE_LABELS, hasFeature } from '../plans/plans';
import { SUBTITLE_MAX, TAGLINE_MAX, cleanText, pickLayout } from '../common/menu-fields';

// Datos de la sección en la carta (todos opcionales)
interface CategoryInput {
  destination?: Destination;
  subtitle?: string | null;
  tagline?: string | null;
  layout?: string;
}

type CategoryWithCount = Category & { _count?: { menuItems: number } };

export function mapCategory(c: CategoryWithCount) {
  return {
    _id: c.id,
    name: c.name,
    position: c.position,
    destination: c.destination,
    subtitle: c.subtitle,
    tagline: c.tagline,
    layout: c.layout,
    ...(c._count && { itemsCount: c._count.menuItems }),
  };
}

// Compara nombres sin tildes ni mayúsculas ("Café" y "cafe" son la misma categoría)
const normalize = (name: string) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const categories = await this.prisma.category.findMany({
      where: { tenantId },
      include: { _count: { select: { menuItems: true } } },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    return categories.map(mapCategory);
  }

  async create(tenantId: string, input: CategoryInput & { name: string }) {
    const name = this.cleanName(input.name);
    const destination = input.destination ?? Destination.KITCHEN;
    await this.assertDestinationAllowed(tenantId, destination);
    await this.assertNameAvailable(tenantId, name);

    try {
      // la categoría nueva queda al final
      const last = await this.prisma.category.aggregate({ where: { tenantId }, _max: { position: true } });
      const category = await this.prisma.category.create({
        data: {
          tenantId,
          name,
          destination,
          subtitle: cleanText(input.subtitle, SUBTITLE_MAX, 'El subtítulo') ?? null,
          tagline: cleanText(input.tagline, TAGLINE_MAX, 'El texto de la derecha') ?? null,
          layout: pickLayout(input.layout),
          position: (last._max.position ?? -1) + 1,
        },
      });
      return mapCategory(category);
    } catch (error) {
      this.rethrowIfDuplicate(error);
      throw error;
    }
  }

  async update(tenantId: string, id: string, input: CategoryInput & { name?: string }) {
    const current = await this.prisma.category.findFirst({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('Categoría no encontrada');

    const name = input.name === undefined ? undefined : this.cleanName(input.name);
    if (name !== undefined) await this.assertNameAvailable(tenantId, name, id);
    // Solo se valida el destino si realmente cambia: una categoría que ya estaba en barra
    // puede renombrarse aunque el plan haya cambiado después.
    if (input.destination && input.destination !== current.destination) {
      await this.assertDestinationAllowed(tenantId, input.destination);
    }

    try {
      const category = await this.prisma.category.update({
        where: { id },
        data: {
          name,
          destination: input.destination,
          subtitle: cleanText(input.subtitle, SUBTITLE_MAX, 'El subtítulo'),
          tagline: cleanText(input.tagline, TAGLINE_MAX, 'El texto de la derecha'),
          layout: pickLayout(input.layout),
        },
      });
      return mapCategory(category);
    } catch (error) {
      this.rethrowIfDuplicate(error);
      throw error;
    }
  }

  // Los platos de la categoría no se borran: quedan "sin categoría".
  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    const { count } = await this.prisma.category.deleteMany({ where: { id, tenantId } });
    if (count === 0) throw new NotFoundException('Categoría no encontrada');
    return { message: 'Categoría eliminada' };
  }

  // Recibe los ids en el orden deseado y guarda la posición de cada una.
  async reorder(tenantId: string, ids: unknown) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new BadRequestException('Se esperaba una lista de ids de categorías');
    }
    await this.prisma.$transaction(
      (ids as string[]).map((id, index) =>
        this.prisma.category.updateMany({ where: { id, tenantId }, data: { position: index } }),
      ),
    );
    return this.findAll(tenantId);
  }

  private cleanName(name: unknown): string {
    const cleaned = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
    if (!cleaned) throw new BadRequestException('El nombre de la categoría es obligatorio');
    if (cleaned.length > 60) throw new BadRequestException('El nombre es demasiado largo (máximo 60 caracteres)');
    return cleaned;
  }

  private async assertNameAvailable(tenantId: string, name: string, excludeId?: string) {
    const target = normalize(name);
    const all = await this.prisma.category.findMany({ where: { tenantId }, select: { id: true, name: true } });
    if (all.some((c) => c.id !== excludeId && normalize(c.name) === target)) {
      throw new ConflictException('Ya existe una categoría con ese nombre');
    }
  }

  // Mandar una categoría a la barra solo se puede si el plan incluye separar cocina y barra.
  private async assertDestinationAllowed(tenantId: string, destination: Destination) {
    if (destination !== Destination.BAR) return;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || !hasFeature(tenant, 'kitchen_bar_split')) {
      throw new ForbiddenException(`Tu plan no incluye "${FEATURE_LABELS.kitchen_bar_split}"`);
    }
  }

  private rethrowIfDuplicate(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Ya existe una categoría con ese nombre');
    }
  }
}
