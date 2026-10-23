import { PrismaService } from '../prisma/prisma.service';
import { slugify } from '../reservations/reservations.logic';

// Código del local: minúsculas, números y guiones; de 3 a 40 caracteres, sin guion al principio ni al final
export const LOGIN_CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const normalizeLoginCode = (code: unknown): string => String(code ?? '').trim().toLowerCase();

// Usuario: minúsculas; letras, números y . _ - @ +  (un email también sirve)
export const USERNAME_RE = /^[a-z0-9._@+-]{3,60}$/;
export const normalizeUsername = (u: unknown): string => String(u ?? '').trim().toLowerCase();

// Un código libre armado con el nombre del local; si ya existe, se le suma un número (-2, -3…)
export async function freeLoginCode(prisma: Pick<PrismaService, 'tenant'>, name: string): Promise<string> {
  let base = slugify(name);
  if (base.length < 3) base = `${base}-local`.slice(0, 40);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base.slice(0, 36)}-${i + 1}`;
    if (!(await prisma.tenant.findUnique({ where: { loginCode: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base.slice(0, 28)}-${Date.now().toString(36)}`;
}
