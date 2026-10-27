import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReservationSource, VoucherStatus } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { timeToMin } from '../reservations/reservations.logic';
import { ReservationsService } from '../reservations/reservations.service';
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
import { hasFeature } from '../plans/plans';

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

export interface HotelReserveInput {
  tenantId: string;
  accessCode: string;
  date: string;
  time: string;
  partySize: number;
  guestName: string;
  guestPhone: string;
  notes?: string;
  // El huésped puede pedir también su voucher al reservar (es opcional): ahí hacen falta nombre y apellido y documento
  wantVoucher?: boolean;
  document?: string;
}

export interface IssueVoucherInput {
  tenantId: string;
  guestName: string; // nombre y apellido
  document: string; // DNI o pasaporte
  accessCode: string;
}

@Injectable()
export class HotelsService {
  constructor(private readonly prisma: PrismaService, private readonly reservations: ReservationsService) {}

  // Pantalla pública del hotel: sus datos y los restaurantes adheridos con su descuento.
  async publicInfo(slug: string) {
    const hotel = await this.findActiveHotel(slug);
    const partners = await this.prisma.hotelPartner.findMany({
      where: { hotelId: hotel.id, active: true },
      include: { tenant: true },
      orderBy: { tenant: { name: 'asc' } },
    });
    // un restaurante cuyo plan no incluye hoteles no recibe vouchers
    const eligible = partners.filter((p) => hasFeature(p.tenant.plan, 'hotels'));
    return {
      name: hotel.name,
      slug: hotel.slug,
      voucherValidDays: hotel.voucherValidDays,
      restaurants: eligible.map((p) => ({
        id: p.tenantId,
        name: p.tenant.name,
        address: p.tenant.address,
        city: p.tenant.city,
        logoUrl: p.tenant.logoUrl,
        discountPct: p.discountPct,
        conditions: p.conditions,
        // si el restaurante recibe reservas, la pantalla del hotel ofrece "Reservar mesa"
        reservable: p.tenant.reservationsEnabled && hasFeature(p.tenant.plan, 'reservations'),
        maxParty: p.tenant.reservationMaxParty,
      })),
    };
  }

  // Horarios con lugar de un restaurante adherido (no es un dato sensible: no pide el código del hotel)
  async reservationAvailability(slug: string, tenantId: string, day: string, partySize: number, now = new Date()) {
    const { tenant } = await this.reservablePartner(slug, tenantId);
    return this.reservations.availabilityFor(tenant, day, partySize, now);
  }

  /**
   * El huésped reserva mesa en un restaurante adherido. Es independiente del voucher: puede reservar sin pedirlo,
   * o pedirlo en el mismo paso (casilla "Quiero también mi descuento"). La prueba de que está alojado sigue siendo
   * el código del hotel, igual que para el voucher, así que no se puede usar esta pantalla para llenar de reservas.
   */
  async reserve(slug: string, input: HotelReserveInput, now = new Date()) {
    const hotel = await this.findActiveHotel(slug);
    if (!sameCode(hotel.accessCode, input.accessCode)) {
      throw new ForbiddenException('El código del hotel no es correcto. Pedilo en recepción.');
    }
    const { tenant } = await this.reservablePartner(slug, input.tenantId);
    const startMin = timeToMin(input.time);
    if (startMin === null) throw new BadRequestException('El horario no es válido');

    // El voucher se pide primero: si algo de sus reglas no se cumple (documento, tope, 24 h), no se reserva a medias.
    // Si después no hay lugar, el voucher queda vigente y al volver a pedirlo se le devuelve el mismo.
    let voucher: Awaited<ReturnType<HotelsService['issueVoucher']>> | null = null;
    let voucherId: string | null = null;
    if (input.wantVoucher) {
      voucher = await this.issueVoucher(slug, {
        tenantId: input.tenantId,
        guestName: input.guestName,
        document: input.document ?? '',
        accessCode: input.accessCode,
      }, now);
      const row = await this.prisma.hotelVoucher.findUnique({ where: { code: voucher.code }, select: { id: true } });
      // un voucher se asocia a una sola reserva: si ya está en otra, esta reserva va sin vincular
      const taken = row ? await this.prisma.reservation.findUnique({ where: { voucherId: row.id }, select: { id: true } }) : null;
      voucherId = row && !taken ? row.id : null;
    }

    const reservation = await this.reservations.book(
      tenant,
      {
        date: input.date,
        startMin,
        partySize: input.partySize,
        guestName: input.guestName,
        guestPhone: input.guestPhone,
        notes: input.notes,
        source: ReservationSource.HOTEL,
        hotelId: hotel.id,
        voucherId,
      },
      { enforceRules: true, enforceCapacity: true, now },
    );
    return { reservation: this.reservations.confirmationOf(tenant, reservation), voucher };
  }

  // Sin lugar: el huésped se anota en la lista de espera del restaurante
  async reserveWaitlist(
    slug: string,
    input: { tenantId: string; accessCode: string; date: string; fromTime: string; toTime: string; partySize: number; guestName: string; guestPhone: string },
    now = new Date(),
  ) {
    const hotel = await this.findActiveHotel(slug);
    if (!sameCode(hotel.accessCode, input.accessCode)) {
      throw new ForbiddenException('El código del hotel no es correcto. Pedilo en recepción.');
    }
    const { tenant } = await this.reservablePartner(slug, input.tenantId);
    return this.reservations.joinWaitlist(tenant, { ...input, hotelId: hotel.id }, now);
  }

  private async reservablePartner(slug: string, tenantId: string) {
    const hotel = await this.findActiveHotel(slug);
    const partner = await this.prisma.hotelPartner.findFirst({
      where: { hotelId: hotel.id, tenantId, active: true },
      include: { tenant: true },
    });
    if (!partner) throw new NotFoundException('Ese restaurante no está adherido a este hotel');
    if (!partner.tenant.reservationsEnabled || !hasFeature(partner.tenant.plan, 'reservations')) throw new NotFoundException('Este restaurante no recibe reservas por acá');
    return { hotel, tenant: partner.tenant };
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
    if (!partner || !hasFeature(partner.tenant.plan, 'hotels')) throw new NotFoundException('Ese restaurante no está adherido a este hotel');

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
