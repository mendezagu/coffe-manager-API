import { randomBytes, randomInt, timingSafeEqual } from 'crypto';

// Código secreto del QR de una mesa: 24 caracteres aleatorios (144 bits). No se puede adivinar ni
// recorrer probando mesas, y no dice nada del negocio ni de la mesa.
export const newQrToken = () => randomBytes(18).toString('base64url');

// Código de mesa (opcional): 4 dígitos que cambian cada vez que la mesa se libera.
export const newTablePin = () => String(randomInt(0, 10000)).padStart(4, '0');

// Los códigos de las mesas que ya existen se comparan sin revelar en cuánto coinciden
export function samePin(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
