import { BadRequestException } from '@nestjs/common';

// Colores de la etiqueta que va sobre la foto del plato (se eligen de una lista: nadie diseña colores sueltos)
export const BADGE_COLORS = ['terracotta', 'green', 'red', 'blue', 'amber', 'dark'] as const;
// Cómo se muestran los platos de una categoría en la carta
export const CATEGORY_LAYOUTS = ['grid', 'list', 'hero'] as const;

export const DESCRIPTION_MAX = 160;
export const BADGE_MAX = 20;
export const SUBTITLE_MAX = 60;
export const TAGLINE_MAX = 30;

/** Texto opcional: sin espacios de más; vacío = null (se borra). undefined = no se toca. */
export function cleanText(value: unknown, max: number, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label} no es válido`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new BadRequestException(`${label} puede tener hasta ${max} caracteres`);
  return text || null;
}

export function pickBadgeColor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(BADGE_COLORS as readonly string[]).includes(String(value))) throw new BadRequestException('El color de la etiqueta no es válido');
  return String(value);
}

export function pickLayout(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!(CATEGORY_LAYOUTS as readonly string[]).includes(String(value))) throw new BadRequestException('El formato de la categoría no es válido');
  return String(value);
}
