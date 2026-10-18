import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VoucherStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

export interface HotelInput {
  name?: string;
  slug?: string;
  accessCode?: string;
  contact?: string;
  active?: boolean;
  voucherValidDays?: number;
}

export interface PartnerInput {
  tenantId: string;
  discountPct: number;
  conditions?: string;
  active?: boolean;
}

@Injectable()
export class HotelsAdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Dueño de la plataforma: hoteles y sus restaurantes ----

  async listHotels() {
    const hotels = await this.prisma.hotel.findMany({
      orderBy: { name: 'asc' },
      include: {
        partners: { include: { tenant: { select: { id: true, name: true } } } },
        users: { orderBy: { createdAt: 'asc' } },
      },
    });
    const counts = await this.prisma.hotelVoucher.groupBy({ by: ['hotelId', 'status'], _count: true });
    return hotels.map((h) => {
      const of = (status: VoucherStatus) => counts.find((c) => c.hotelId === h.id && c.status === status)?._count ?? 0;
      return {
        id: h.id,
        name: h.name,
        slug: h.slug,
        accessCode: h.accessCode,
        contact: h.contact,
        active: h.active,
        voucherValidDays: h.voucherValidDays,
        vouchers: { issued: of(VoucherStatus.ISSUED), redeemed: of(VoucherStatus.REDEEMED) },
        users: h.users.map((u) => ({ id: u.id, email: u.email, name: u.name, active: u.active })),
        partners: h.partners
          .map((p) => ({ tenantId: p.tenantId, name: p.tenant.name, discountPct: p.discountPct, conditions: p.conditions, active: p.active }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  async createHotel(input: HotelInput) {
    const name = input.name?.trim();
    const slug = input.slug?.trim().toLowerCase();
    const accessCode = input.accessCode?.trim();
    if (!name || !slug || !accessCode) throw new BadRequestException('Faltan el nombre, la dirección o el código');
    this.assertSlug(slug);
    try {
      return await this.prisma.hotel.create({
        data: { name, slug, accessCode, contact: input.contact?.trim() ?? '', voucherValidDays: input.voucherValidDays ?? 3 },
      });
    } catch (e) {
      throw this.duplicate(e);
    }
  }

  async updateHotel(id: string, input: HotelInput) {
    const data: Prisma.HotelUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.accessCode !== undefined) data.accessCode = input.accessCode.trim();
    if (input.contact !== undefined) data.contact = input.contact.trim();
    if (input.active !== undefined) data.active = input.active;
    if (input.voucherValidDays !== undefined) data.voucherValidDays = input.voucherValidDays;
    if (input.slug !== undefined) {
      data.slug = input.slug.trim().toLowerCase();
      this.assertSlug(data.slug);
    }
    if (data.name === '' || data.accessCode === '') throw new BadRequestException('El nombre y el código no pueden quedar vacíos');
    try {
      return await this.prisma.hotel.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Hotel no encontrado');
      throw this.duplicate(e);
    }
  }

  // Alta o cambio de un restaurante en un hotel (si ya estaba, actualiza su descuento y lo reactiva)
  async setPartner(hotelId: string, input: PartnerInput) {
    if (!(input.discountPct > 0 && input.discountPct <= 100)) throw new BadRequestException('El descuento tiene que estar entre 0 y 100');
    const [hotel, tenant] = await Promise.all([
      this.prisma.hotel.findUnique({ where: { id: hotelId } }),
      this.prisma.tenant.findUnique({ where: { id: input.tenantId } }),
    ]);
    if (!hotel) throw new NotFoundException('Hotel no encontrado');
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    const data = {
      discountPct: input.discountPct,
      active: input.active ?? true,
      ...(input.conditions !== undefined && { conditions: input.conditions.trim() }),
    };
    return this.prisma.hotelPartner.upsert({
      where: { hotelId_tenantId: { hotelId, tenantId: input.tenantId } },
      create: { hotelId, tenantId: input.tenantId, ...data },
      update: data,
    });
  }

  // Accesos del hotel a su portal. El dueño les pone una contraseña inicial (no hay envío de mails).
  async createHotelUser(hotelId: string, input: { email: string; name?: string; password: string }) {
    const email = input.email?.trim().toLowerCase();
    if (!email || !/^[^s@]+@[^s@]+.[^s@]+$/.test(email)) throw new BadRequestException('El email no es válido');
    if (!input.password || input.password.length < 8) throw new BadRequestException('La contraseña tiene que tener al menos 8 caracteres');
    if (!(await this.prisma.hotel.findUnique({ where: { id: hotelId } }))) throw new NotFoundException('Hotel no encontrado');
    try {
      const user = await this.prisma.hotelUser.create({
        data: { hotelId, email, name: input.name?.trim() || 'Recepción', passwordHash: await bcrypt.hash(input.password, 10) },
      });
      return { id: user.id, email: user.email, name: user.name, active: user.active };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Ya existe un acceso con ese email');
      throw e;
    }
  }

  async updateHotelUser(id: string, input: { password?: string; active?: boolean; name?: string }) {
    const data: Prisma.HotelUserUpdateInput = {};
    if (input.active !== undefined) data.active = input.active;
    if (input.name !== undefined) data.name = input.name.trim() || 'Recepción';
    if (input.password !== undefined) {
      if (input.password.length < 8) throw new BadRequestException('La contraseña tiene que tener al menos 8 caracteres');
      data.passwordHash = await bcrypt.hash(input.password, 10);
    }
    try {
      const user = await this.prisma.hotelUser.update({ where: { id }, data });
      return { id: user.id, email: user.email, name: user.name, active: user.active };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') throw new NotFoundException('Acceso no encontrado');
      throw e;
    }
  }

  // ---- Restaurante: sus propias alianzas ----

  async listPartnerships(tenantId: string) {
    const rows = await this.prisma.hotelPartner.findMany({
      where: { tenantId },
      include: { hotel: true },
      orderBy: { hotel: { name: 'asc' } },
    });
    return rows.map((p) => ({ id: p.id, hotelName: p.hotel.name, discountPct: p.discountPct, conditions: p.conditions, active: p.active }));
  }

  // El restaurante ajusta su descuento, sus condiciones o pausa la alianza. Solo las suyas.
  async updatePartnership(tenantId: string, id: string, input: { discountPct?: number; conditions?: string; active?: boolean }) {
    if (input.discountPct !== undefined && !(input.discountPct > 0 && input.discountPct <= 100)) {
      throw new BadRequestException('El descuento tiene que estar entre 0 y 100');
    }
    const { count } = await this.prisma.hotelPartner.updateMany({
      where: { id, tenantId },
      data: {
        ...(input.discountPct !== undefined && { discountPct: input.discountPct }),
        ...(input.conditions !== undefined && { conditions: input.conditions.trim() }),
        ...(input.active !== undefined && { active: input.active }),
      },
    });
    if (!count) throw new NotFoundException('Alianza no encontrada');
    return (await this.listPartnerships(tenantId)).find((p) => p.id === id);
  }

  private assertSlug(slug: string) {
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new BadRequestException('La dirección solo puede tener minúsculas, números y guiones');
  }

  private duplicate(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new ConflictException('Ya existe un hotel con esa dirección');
    return e;
  }
}
