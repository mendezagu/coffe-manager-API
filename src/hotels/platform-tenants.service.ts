import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PLAN_FEATURES } from '../plans/plans';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateTenantInput {
  name: string;
  adminEmail: string;
  adminName?: string;
  password: string;
  plan?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Alta de restaurantes por el dueño de la plataforma (lo mismo que `npm run tenant:create`, pero desde la app)
@Injectable()
export class PlatformTenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, plan: true, createdAt: true, _count: { select: { users: true, hotelPartners: true } } },
    });
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      plan: t.plan,
      createdAt: t.createdAt,
      users: t._count.users,
      hotels: t._count.hotelPartners,
    }));
  }

  async create(input: CreateTenantInput) {
    const name = input.name?.trim();
    const email = input.adminEmail?.trim().toLowerCase();
    const plan = input.plan ?? 'pro';
    if (!name) throw new BadRequestException('Falta el nombre del restaurante');
    if (!email || !EMAIL.test(email)) throw new BadRequestException('El email del administrador no es válido');
    if (!input.password || input.password.length < 8) throw new BadRequestException('La contraseña tiene que tener al menos 8 caracteres');
    if (!(plan in PLAN_FEATURES)) throw new BadRequestException(`Plan desconocido. Planes: ${Object.keys(PLAN_FEATURES).join(', ')}`);
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Ya existe un usuario con ese email');

    const tenant = await this.prisma.tenant.create({
      data: {
        name,
        plan,
        users: {
          create: {
            email,
            name: input.adminName?.trim() || 'Administrador',
            role: Role.ADMIN,
            passwordHash: await bcrypt.hash(input.password, 10),
          },
        },
      },
    });
    return { id: tenant.id, name: tenant.name, plan: tenant.plan, adminEmail: email };
  }
}
