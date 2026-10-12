import { BadRequestException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

// Cliente de Prisma o transacción: la validación corre en ambos
type Db = PrismaClient | Prisma.TransactionClient;

// Copia del modificador elegido, guardada en la orden y en la venta
export interface ModifierSnapshot {
  groupId: string;
  group: string;
  optionId: string;
  name: string;
  priceDelta: number;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Lo que suman (o restan) los modificadores al precio de una unidad
export function modifiersTotal(modifiers: unknown): number {
  return round2(readSnapshot(modifiers).reduce((sum, m) => sum + m.priceDelta, 0));
}

// El JSON guardado en la base se lee con cuidado: nunca debería romper un cobro
export function readSnapshot(value: unknown): ModifierSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is ModifierSnapshot =>
      !!m && typeof m === 'object' && typeof (m as any).optionId === 'string' && Number.isFinite((m as any).priceDelta),
  );
}

// Identifica una combinación de opciones (para fusionar líneas iguales)
export const modifiersKey = (modifiers: unknown) =>
  readSnapshot(modifiers)
    .map((m) => m.optionId)
    .sort()
    .join('|');

/**
 * Valida las opciones que el mozo eligió para un plato y devuelve la copia que se guarda en la orden.
 * El servidor decide el precio: del cliente solo llegan los ids de las opciones.
 *  - cada opción debe existir, estar activa y ser de un grupo que ese plato ofrece;
 *  - un grupo de "una opción" no admite dos;
 *  - un grupo obligatorio no puede quedar sin elección.
 */
export async function resolveModifiers(
  db: Db,
  tenantId: string,
  menuItemId: string,
  itemName: string,
  optionIds: unknown,
): Promise<ModifierSnapshot[]> {
  const ids = Array.isArray(optionIds) ? [...new Set(optionIds.filter((i): i is string => typeof i === 'string'))] : [];

  const offered = await db.menuItemModifierGroup.findMany({
    where: { menuItemId, group: { tenantId } },
    include: { group: { include: { options: { where: { active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] } } } },
    orderBy: { position: 'asc' },
  });

  const optionToGroup = new Map<string, (typeof offered)[number]['group']>();
  for (const { group } of offered) for (const option of group.options) optionToGroup.set(option.id, group);

  const unknown = ids.filter((id) => !optionToGroup.has(id));
  if (unknown.length) {
    throw new BadRequestException(`Hay opciones que "${itemName}" no ofrece o que ya no están disponibles`);
  }

  const snapshot: ModifierSnapshot[] = [];
  for (const { group } of offered) {
    const chosen = group.options.filter((o) => ids.includes(o.id));
    if (group.selection === 'SINGLE' && chosen.length > 1) {
      throw new BadRequestException(`En "${group.name}" se puede elegir una sola opción`);
    }
    if (group.required && chosen.length === 0 && group.options.length > 0) {
      throw new BadRequestException(`Elegí una opción de "${group.name}" para "${itemName}"`);
    }
    for (const option of chosen) {
      snapshot.push({
        groupId: group.id,
        group: group.name,
        optionId: option.id,
        name: option.name,
        priceDelta: option.priceDelta,
      });
    }
  }
  return snapshot;
}
