/**
 * Crea un negocio nuevo con su primer administrador.
 *
 *   npm run tenant:create -- --name "La Pizzería" --email admin@pizzeria.com --password "clave-larga-123"
 *
 * Opcional: --adminName "Nombre del admin"
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import 'dotenv/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg('name');
  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  const adminName = arg('adminName') ?? 'Administrador';

  if (!name || !email || !password) {
    console.error('Uso: npm run tenant:create -- --name "Negocio" --email admin@correo.com --password "clave"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('La contraseña tiene que tener al menos 8 caracteres.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    if (await prisma.user.findUnique({ where: { email } })) {
      console.error(`Ya existe un usuario con el email ${email}.`);
      process.exit(1);
    }
    const tenant = await prisma.tenant.create({
      data: {
        name: name.trim(),
        users: {
          create: { email, name: adminName, role: Role.ADMIN, passwordHash: await bcrypt.hash(password, 10) },
        },
      },
    });
    console.log(`Negocio "${tenant.name}" creado (id ${tenant.id}). Admin: ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
