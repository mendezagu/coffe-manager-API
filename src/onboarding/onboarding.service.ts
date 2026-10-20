import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MENU_TEMPLATES, findTemplate } from './templates';

const MAX_TABLES_AT_ONCE = 100;

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  // Todo lo que necesita el asistente y el checklist del inicio en una sola llamada
  async status(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');

    const [menuItems, exampleItems, categories, tables, waiters, sectors, modifierGroups, cashRegisters, sales] =
      await Promise.all([
        this.prisma.menuItem.count({ where: { tenantId } }),
        this.prisma.menuItem.count({ where: { tenantId, isExample: true } }),
        this.prisma.category.count({ where: { tenantId } }),
        this.prisma.table.count({ where: { tenantId } }),
        this.prisma.waiter.count({ where: { tenantId } }),
        this.prisma.sector.count({ where: { tenantId } }),
        this.prisma.modifierGroup.count({ where: { tenantId } }),
        this.prisma.cashRegister.count({ where: { tenantId } }),
        this.prisma.sale.count({ where: { tenantId } }),
      ]);

    return {
      done: tenant.onboardingDone,
      counts: { menuItems, exampleItems, categories, tables, waiters, sectors, modifierGroups, cashRegisters, sales },
      templates: MENU_TEMPLATES.map((t) => ({
        key: t.key,
        label: t.label,
        categories: t.categories.map((c) => ({ name: c.name, items: c.items })),
      })),
    };
  }

  // Carga el menú de ejemplo. Solo si el negocio todavía no tiene platos: así no se mezcla con uno real.
  async applyTemplate(tenantId: string, key: string) {
    const template = findTemplate(key);
    if (!template) throw new NotFoundException('Plantilla no encontrada');
    if ((await this.prisma.menuItem.count({ where: { tenantId } })) > 0) {
      throw new ConflictException('Ya tenés platos cargados: la plantilla es solo para empezar de cero');
    }

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.category.aggregate({ where: { tenantId }, _max: { position: true } });
      let position = (last._max.position ?? -1) + 1;
      let items = 0;
      let categories = 0;
      for (const cat of template.categories) {
        // si ya había una categoría con ese nombre (sin platos), se reutiliza y no se marca como ejemplo
        const existing = await tx.category.findFirst({ where: { tenantId, name: cat.name } });
        const category =
          existing ??
          (await tx.category.create({ data: { tenantId, name: cat.name, position: position++, isExample: true } }));
        if (!existing) categories++;
        await tx.menuItem.createMany({
          data: cat.items.map((i) => ({
            tenantId,
            name: i.name,
            price: i.price,
            categoryId: category.id,
            isExample: true,
          })),
        });
        items += cat.items.length;
      }
      return { items, categories };
    });
  }

  // Borra lo que quedó de la plantilla sin tocar: los platos que el dueño editó dejan de ser "de ejemplo"
  async removeTemplate(tenantId: string) {
    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.menuItem.deleteMany({ where: { tenantId, isExample: true } });
      // una categoría de ejemplo que todavía tiene platos propios se conserva (ya es del dueño)
      const emptied = await tx.category.deleteMany({ where: { tenantId, isExample: true, menuItems: { none: {} } } });
      await tx.category.updateMany({ where: { tenantId, isExample: true }, data: { isExample: false } });
      return { items: removed.count, categories: emptied.count };
    });
  }

  // Crea varias mesas de una vez ("Mesa 1", "Mesa 2"...), siguiendo la numeración que ya exista
  async createTables(tenantId: string, count: number) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_TABLES_AT_ONCE) {
      throw new BadRequestException(`Elegí entre 1 y ${MAX_TABLES_AT_ONCE} mesas`);
    }
    const existing = await this.prisma.table.findMany({ where: { tenantId }, select: { name: true } });
    const highest = existing.reduce((max, t) => {
      const m = /^Mesa (\d+)$/.exec(t.name);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);

    // una por una, en orden: `seq` es autoincremental y define cómo se ordenan en pantalla
    for (let n = 1; n <= count; n++) {
      await this.prisma.table.create({ data: { tenantId, name: `Mesa ${highest + n}` } });
    }
    return { created: count };
  }
}
