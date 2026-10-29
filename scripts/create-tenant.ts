/**
 * Crea un negocio nuevo con su primer administrador.
 *
 *   npm run tenant:create -- --name "La Pizzería" --email admin@pizzeria.com --password "clave-larga-123"
 *
 * Opcional: --adminName "Nombre del admin"  --plan takeaway|basic|pro|benefits   (por defecto: pro)
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import 'dotenv/config';
import { freeLoginCode } from '../src/auth/login-code';
import { PLAN_FEATURES } from '../src/plans/plans';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const name = arg('name');
  const email = arg('email')?.trim().toLowerCase();
  const password = arg('password');
  const adminName = arg('adminName') ?? 'Administrador';
  const plan = arg('plan') ?? 'pro';

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
    if (!(plan in PLAN_FEATURES)) {
      console.error(`Plan desconocido "${plan}". Planes: ${Object.keys(PLAN_FEATURES).join(', ')}`);
      process.exit(1);
    }
    // El usuario solo tiene que ser único dentro del local (el local nuevo todavía no tiene usuarios)
    const loginCode = await freeLoginCode(prisma, name);
    const tenant = await prisma.tenant.create({
      data: {
        name: name.trim(),
        loginCode,
        plan,
        salesMode: plan === 'takeaway' ? 'counter' : 'both',
        users: {
          create: { email, name: adminName, role: Role.ADMIN, passwordHash: await bcrypt.hash(password, 10) },
        },
      },
    });
    console.log(`Negocio "${tenant.name}" creado (id ${tenant.id}). Admin: ${email}`);
    console.log(`Código del local para ingresar: ${tenant.loginCode}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
