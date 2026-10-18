import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VoucherStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { findUsableVoucher, newVoucherCode, normalizeCode } from './vouchers.logic';

// Cuántos vouchers sin usar puede tener a la vez un mismo huésped en un hotel
export const MAX_ACTIVE_VOUCHERS_PER_GUEST = 3;

const sameCode = (expected: string, given: unknown) => {
  const a = Buffer.from(normalizeCode(expected));
  const b = Buffer.from(normalizeCode(given));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

export interface IssueVoucherInput {
  tenantId: string;
  guestName: string;
  accessCode: string;
}

@Injectable()
export class HotelsService {
  constructor(private readonly prisma: PrismaService) {}

  // Pantalla pública del hotel: sus datos y los restaurantes adheridos con su descuento.
  async publicInfo(slug: string) {
    const hotel = await this.findActiveHotel(slug);
    const partners = await this.prisma.hotelPartner.findMany({
      where: { hotelId: hotel.id, active: true },
      include: { tenant: true },
      orderBy: { tenant: { name: 'asc' } },
    });
    return {
      name: hotel.name,
      slug: hotel.slug,
      voucherValidDays: hotel.voucherValidDays,
      restaurants: partners.map((p) => ({
        id: p.tenantId,
        name: p.tenant.name,
        address: p.tenant.address,
        city: p.tenant.city,
        logoUrl: p.tenant.logoUrl,
        discountPct: p.discountPct,
        conditions: p.conditions,
      })),
    };
  }

  /**
   * El huésped pide un voucher para un restaurante. La prueba de que está alojado es el código vigente
   * del hotel: el hotel no tiene que mandar ninguna lista de huéspedes.
   */
  async issueVoucher(slug: string, input: IssueVoucherInput, now = new Date()) {
    const hotel = await this.findActiveHotel(slug);
    if (!sameCode(hotel.accessCode, input.accessCode)) {
      throw new ForbiddenException('El código del hotel no es correcto. Pedilo en recepción.');
    }
    const partner = await this.prisma.hotelPartner.findFirst({
      where: { hotelId: hotel.id, tenantId: input.tenantId, active: true },
      include: { tenant: true },
    });
    if (!partner) throw new NotFoundException('Ese restaurante no está adherido a este hotel');

    const guestName = input.guestName.trim().replace(/\s+/g, ' ');
    if (guestName.length < 2) throw new BadRequestException('Escribí tu nombre');

    const active = await this.prisma.hotelVoucher.count({
      where: {
        hotelId: hotel.id,
        guestName: { equals: guestName, mode: 'insensitive' },
        status: VoucherStatus.ISSUED,
        validTo: { gte: now },
      },
    });
    if (active >= MAX_ACTIVE_VOUCHERS_PER_GUEST) {
      throw new BadRequestException('Ya tenés vouchers sin usar. Usalos o esperá a que venzan.');
    }

    const validTo = new Date(now.getTime() + hotel.voucherValidDays * 24 * 60 * 60 * 1000);
    // El código es aleatorio y corto: en el raro caso de choque se reintenta con otro
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const voucher = await this.prisma.hotelVoucher.create({
          data: {
            code: newVoucherCode(),
            hotelId: hotel.id,
            tenantId: partner.tenantId,
            guestName,
            discountPct: partner.discountPct,
            validFrom: now,
            validTo,
          },
        });
        return {
          code: voucher.code,
          guestName: voucher.guestName,
          hotelName: hotel.name,
          restaurantName: partner.tenant.name,
          discountPct: voucher.discountPct,
          conditions: partner.conditions,
          validTo: voucher.validTo,
        };
      } catch (error) {
        const collision = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!collision) throw error;
      }
    }
    throw new BadRequestException('No se pudo generar el voucher, probá de nuevo');
  }

  // El cajero revisa un voucher antes de cobrar: de qué hotel es y cuánto descuenta. No lo gasta.
  async validate(tenantId: string, code: string) {
    const v = await findUsableVoucher(this.prisma, tenantId, code);
    return {
      code: v.code,
      hotelName: v.hotelName,
      guestName: v.guestName,
      discountPct: v.discountPct,
      validTo: v.validTo,
    };
  }

  private async findActiveHotel(slug: string) {
    const hotel = await this.prisma.hotel.findUnique({ where: { slug } });
    if (!hotel || !hotel.active) throw new NotFoundException('Hotel no encontrado');
    return hotel;
  }
}
