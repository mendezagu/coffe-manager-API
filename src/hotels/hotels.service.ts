import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VoucherStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  documentHash,
  documentHint,
  findUsableVoucher,
  isValidDocument,
  newVoucherCode,
  normalizeCode,
  normalizeDocument,
  normalizeName,
} from './vouchers.logic';

// Cuántos vouchers sin usar puede tener a la vez un mismo huésped (por documento) en un hotel
export const MAX_ACTIVE_VOUCHERS_PER_GUEST = 3;
// Después de usar un voucher en un restaurante, hay que esperar este tiempo para pedir otro en ese mismo restaurante
export const VOUCHER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const sameCode = (expected: string, given: unknown) => {
  const a = Buffer.from(normalizeCode(expected));
  const b = Buffer.from(normalizeCode(given));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

// Estado de un voucher tal como lo ve el huésped (EXPIRED se calcula: sin usar y pasada su fecha de vencimiento)
export type VoucherStatusName = 'ISSUED' | 'REDEEMED' | 'CANCELLED' | 'EXPIRED';

export interface VoucherStatusView {
  code: string;
  status: VoucherStatusName;
  restaurantId: string;
  restaurantName: string;
  discountPct: number;
  conditions: string;
  validTo: Date;
  redeemedAt: Date | null;
}

// Cuántos códigos se pueden consultar de una vez
export const MAX_STATUS_CODES = 20;

export interface IssueVoucherInput {
  tenantId: string;
  guestName: string; // nombre y apellido
  document: string; // DNI o pasaporte
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
   * del hotel: el hotel no tiene que mandar ninguna lista de huéspedes. Al huésped se lo reconoce por su
   * documento (guardado solo como huella cifrada), no por el nombre, que cualquiera podría cambiar.
   *
   *  - Si ya tiene un voucher vigente para ESE restaurante, se le devuelve el mismo (no se crea otro).
   *  - Si usó un voucher en ese restaurante hace menos de 24 horas, tiene que esperar.
   *  - Nunca más de 3 vouchers sin usar a la vez entre todos los restaurantes.
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
    if (guestName.split(' ').filter((word) => word.length >= 2).length < 2) {
      throw new BadRequestException('Escribí tu nombre y apellido');
    }
    const document = normalizeDocument(input.document);
    if (!isValidDocument(document)) throw new BadRequestException('Escribí tu DNI o pasaporte (solo números y letras)');
    const docHash = documentHash(document);

    const validTo = new Date(now.getTime() + hotel.voucherValidDays * 24 * 60 * 60 * 1000);
    // El código es aleatorio y corto: en el raro caso de choque se reintenta con otro
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Los pedidos del mismo huésped se atienden de a uno: dos toques seguidos no pueden crear dos vouchers
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`voucher:${hotel.id}:${docHash}`}))`;

          const response = (v: { code: string; guestName: string; discountPct: number; validTo: Date }, reused: boolean) => ({
            code: v.code,
            guestName: v.guestName,
            hotelName: hotel.name,
            restaurantName: partner.tenant.name,
            discountPct: v.discountPct,
            conditions: partner.conditions,
            validTo: v.validTo,
            reused,
          });

          // 1) ¿Ya tiene uno vigente para este restaurante? Se le devuelve el mismo.
          const current = await tx.hotelVoucher.findFirst({
            where: { hotelId: hotel.id, tenantId: partner.tenantId, guestDocHash: docHash, status: VoucherStatus.ISSUED, validTo: { gte: now } },
            orderBy: { createdAt: 'desc' },
          });
          if (current) {
            // Solo se lo devuelve a quien escribe el nombre con el que se pidió: con el documento solo no alcanza
            if (normalizeName(current.guestName) !== normalizeName(guestName)) {
              throw new BadRequestException('Ese documento ya tiene un voucher a nombre de otra persona. Consultá en recepción.');
            }
            return response(current, true);
          }

          // 2) ¿Usó uno en este restaurante hace menos de 24 horas?
          const used = await tx.hotelVoucher.findFirst({
            where: {
              hotelId: hotel.id,
              tenantId: partner.tenantId,
              guestDocHash: docHash,
              status: VoucherStatus.REDEEMED,
              redeemedAt: { gt: new Date(now.getTime() - VOUCHER_COOLDOWN_MS) },
            },
            orderBy: { redeemedAt: 'desc' },
          });
          if (used?.redeemedAt) {
            const hours = Math.ceil((used.redeemedAt.getTime() + VOUCHER_COOLDOWN_MS - now.getTime()) / 3_600_000);
            throw new BadRequestException(
              `Ya usaste tu voucher en ${partner.tenant.name}. Podés pedir otro ${hours <= 1 ? 'en menos de 1 hora' : `en ${hours} horas`}.`,
            );
          }

          // 3) Tope de vouchers sin usar a la vez (entre todos los restaurantes del hotel)
          const active = await tx.hotelVoucher.count({
            where: { hotelId: hotel.id, guestDocHash: docHash, status: VoucherStatus.ISSUED, validTo: { gte: now } },
          });
          if (active >= MAX_ACTIVE_VOUCHERS_PER_GUEST) {
            throw new BadRequestException('Ya tenés vouchers sin usar. Usalos o esperá a que venzan.');
          }

          const voucher = await tx.hotelVoucher.create({
            data: {
              code: newVoucherCode(),
              hotelId: hotel.id,
              tenantId: partner.tenantId,
              guestName,
              guestDocHash: docHash,
              guestDocHint: documentHint(document),
              discountPct: partner.discountPct,
              validFrom: now,
              validTo,
            },
          });
          return response(voucher, false);
        });
      } catch (error) {
        const collision = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!collision) throw error;
      }
    }
    throw new BadRequestException('No se pudo generar el voucher, probá de nuevo');
  }
  /**
   * El estado de los vouchers que el celular del huésped ya tiene (los códigos los trae él). Solo se devuelven los
   * de ESTE hotel y nunca datos del huésped (ni nombre ni documento): con un código solo se ve a qué restaurante
   * sirve, cuánto descuenta y si sigue vigente.
   */
  async voucherStatuses(slug: string, rawCodes: string[], now = new Date()): Promise<VoucherStatusView[]> {
    const hotel = await this.findActiveHotel(slug);
    const codes = [...new Set((rawCodes ?? []).map(normalizeCode).filter(Boolean))].slice(0, MAX_STATUS_CODES);
    if (codes.length === 0) return [];
    const rows = await this.prisma.hotelVoucher.findMany({
      where: { hotelId: hotel.id, code: { in: codes } },
      include: { tenant: { select: { name: true } } },
    });
    const partners = await this.prisma.hotelPartner.findMany({
      where: { hotelId: hotel.id, tenantId: { in: [...new Set(rows.map((r) => r.tenantId))] } },
    });
    const conditionsOf = new Map(partners.map((p) => [p.tenantId, p.conditions]));
    return rows
      .map((r) => ({
        code: r.code,
        status: (r.status === VoucherStatus.ISSUED && r.validTo < now ? 'EXPIRED' : r.status) as VoucherStatusName,
        restaurantId: r.tenantId,
        restaurantName: r.tenant.name,
        discountPct: r.discountPct,
        conditions: conditionsOf.get(r.tenantId) ?? '',
        validTo: r.validTo,
        redeemedAt: r.redeemedAt,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  // El cajero revisa un voucher antes de cobrar: de qué hotel es y cuánto descuenta. No lo gasta.
  async validate(tenantId: string, code: string) {
    const v = await findUsableVoucher(this.prisma, tenantId, code);
    return {
      code: v.code,
      hotelName: v.hotelName,
      guestName: v.guestName,
      documentHint: v.documentHint,
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
