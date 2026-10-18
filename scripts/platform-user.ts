/**
 * Cuentas de la consola de plataforma (el dueño de Tavolapp y su equipo). No pertenecen a ningún restaurante.
 *
 *   npm run platform:create -- --email vos@correo.com --password "clave-larga-123" [--name "Agustín"]
 *   npm run platform:create -- --email vos@correo.com --password "otra-clave-123" --reset   (cambia la contraseña)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import 'dotenv/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  const name = arg('name') ?? 'Tavolapp';
  const reset = process.argv.includes('--reset');

  if (!email || !password) {
    console.error('Uso: npm run platform:create -- --email vos@correo.com --password "clave" [--name "Nombre"] [--reset]');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('La contraseña de la consola tiene que tener al menos 10 caracteres.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.platformUser.findUnique({ where: { email } });
    const passwordHash = await bcrypt.hash(password, 10);
    if (existing && !reset) {
      console.error(`Ya existe ${email}. Usá --reset para cambiarle la contraseña.`);
      process.exit(1);
    }
    if (existing) {
      await prisma.platformUser.update({ where: { email }, data: { passwordHash, active: true } });
      console.log(`Contraseña de ${email} actualizada.`);
    } else {
      await prisma.platformUser.create({ data: { email, name, passwordHash } });
      console.log(`Cuenta de plataforma creada: ${email}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
