import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ADDON_FEATURES, Feature, PLAN_FEATURES, SALES_MODES, featuresOf } from '../plans/plans';
import { PrismaService } from '../prisma/prisma.service';
import { freeLoginCode } from '../auth/login-code';

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

  // Restaurantes con lo que cada uno declaró en "Mi negocio" y el email de su administrador.
  // Solo datos de contacto y fiscales: nunca contraseñas, códigos de QR ni nada interno del negocio.
  async list() {
    const tenants = await this.prisma.tenant.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        loginCode: true,
        plan: true,
        addons: true,
        salesMode: true,
        createdAt: true,
        legalName: true,
        taxIdLabel: true,
        taxId: true,
        address: true,
        city: true,
        postalCode: true,
        phone: true,
        ticketFooter: true,
        currencyCode: true,
        locale: true,
        // El logo puede ser una imagen embebida y pesada: acá solo se indica si lo cargó
        logoUrl: true,
        users: { where: { role: Role.ADMIN }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true, active: true } },
        _count: { select: { users: true, hotelPartners: true } },
      },
    });
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      loginCode: t.loginCode,
      plan: t.plan,
      addons: t.addons,
      salesMode: t.salesMode,
      features: featuresOf(t),
      planFeatures: featuresOf(t.plan),
      createdAt: t.createdAt,
      users: t._count.users,
      hotels: t._count.hotelPartners,
      business: {
        legalName: t.legalName,
        taxIdLabel: t.taxIdLabel,
        taxId: t.taxId,
        address: t.address,
        city: t.city,
        postalCode: t.postalCode,
        phone: t.phone,
        ticketFooter: t.ticketFooter,
        currencyCode: t.currencyCode,
        locale: t.locale,
        hasLogo: !!t.logoUrl,
      },
      admins: t.users.map((u) => ({ name: u.name, email: u.email, active: u.active })),
    }));
  }

  // Cambia el plan, los extras y/o el modo de venta del restaurante: rige desde el próximo pedido a la API
  // (lo que ya cargó no se borra). Lo que no viene no se toca.
  async update(id: string, input: { plan?: string; addons?: string[]; salesMode?: string }) {
    const { plan, addons, salesMode } = input;
    if (plan !== undefined && !(plan in PLAN_FEATURES)) throw new BadRequestException(`Plan desconocido. Planes: ${Object.keys(PLAN_FEATURES).join(', ')}`);
    if (addons !== undefined && addons.some((a) => !ADDON_FEATURES.includes(a as Feature))) {
      throw new BadRequestException(`Extra desconocido. Extras: ${ADDON_FEATURES.join(', ')}`);
    }
    if (salesMode !== undefined && !(SALES_MODES as readonly string[]).includes(salesMode)) {
      throw new BadRequestException(`Modo de venta desconocido. Opciones: ${SALES_MODES.join(', ')}`);
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { id: true } });
    if (!tenant) throw new NotFoundException('Restaurante no encontrado');
    return this.prisma.tenant.update({
      where: { id },
      data: { plan, addons: addons === undefined ? undefined : [...new Set(addons)], salesMode },
      select: { id: true, name: true, plan: true, addons: true, salesMode: true },
    });
  }

  async setPlan(id: string, plan: string) {
    return this.update(id, { plan });
  }

  async create(input: CreateTenantInput) {
    const name = input.name?.trim();
    const email = input.adminEmail?.trim().toLowerCase();
    const plan = input.plan ?? 'pro';
    if (!name) throw new BadRequestException('Falta el nombre del restaurante');
    if (!email || !EMAIL.test(email)) throw new BadRequestException('El email del administrador no es válido');
    if (!input.password || input.password.length < 8) throw new BadRequestException('La contraseña tiene que tener al menos 8 caracteres');
    if (!(plan in PLAN_FEATURES)) throw new BadRequestException(`Plan desconocido. Planes: ${Object.keys(PLAN_FEATURES).join(', ')}`);

    // El usuario solo tiene que ser único dentro del local; el local nuevo todavía no tiene usuarios
    const loginCode = await freeLoginCode(this.prisma, name);
    const tenant = await this.prisma.tenant.create({
      data: {
        name,
        loginCode,
        plan,
        // un negocio takeaway no usa mesas: arranca mostrando solo el Mostrador
        salesMode: plan === 'takeaway' ? 'counter' : 'both',
        users: {
          create: {
            email,
            name: input.adminName?.trim() || 'Administrador',
            role: Role.ADMIN,
            passwordHash: await bcrypt.hash(input.password, 10),
            // la contraseña la puso la consola: el dueño la cambia en su primer ingreso
            mustChangePassword: true,
          },
        },
      },
    });
    return { id: tenant.id, name: tenant.name, plan: tenant.plan, adminEmail: email, loginCode: tenant.loginCode };
  }
}
