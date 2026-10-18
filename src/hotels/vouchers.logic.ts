import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient, VoucherStatus } from '@prisma/client';
import { randomInt } from 'crypto';

// Sin 0/O ni 1/I/L: el código se dicta en voz alta en el restaurante
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export const newVoucherCode = () =>
  Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join('');

// Lo que escribe el mozo puede venir en minúsculas o con espacios y guiones
export const normalizeCode = (raw: unknown) =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

type Db = PrismaClient | Prisma.TransactionClient;

export interface ValidVoucher {
  id: string;
  code: string;
  hotelId: string;
  hotelName: string;
  guestName: string;
  discountPct: number;
  validTo: Date;
}

/**
 * Busca el voucher y comprueba que se pueda usar HOY en ESTE negocio. No lo gasta.
 * Los motivos de rechazo son mensajes pensados para que el cajero se los explique al cliente.
 */
export async function findUsableVoucher(db: Db, tenantId: string, rawCode: unknown, now = new Date()): Promise<ValidVoucher> {
  const code = normalizeCode(rawCode);
  const voucher = code
    ? await db.hotelVoucher.findUnique({ where: { code }, include: { hotel: true } })
    : null;
  // Un voucher de otro negocio se trata igual que uno inexistente: no se revela que existe
  if (!voucher || voucher.tenantId !== tenantId) throw new BadRequestException('El voucher no existe');
  if (voucher.status === VoucherStatus.REDEEMED) throw new ConflictException('Este voucher ya fue usado');
  if (voucher.status === VoucherStatus.CANCELLED) throw new BadRequestException('Este voucher fue anulado');
  if (now < voucher.validFrom) throw new BadRequestException('Este voucher todavía no es válido');
  if (now > voucher.validTo) throw new BadRequestException('Este voucher venció');
  if (!voucher.hotel.active) throw new BadRequestException('El hotel de este voucher ya no está adherido');
  return {
    id: voucher.id,
    code: voucher.code,
    hotelId: voucher.hotelId,
    hotelName: voucher.hotel.name,
    guestName: voucher.guestName,
    discountPct: voucher.discountPct,
    validTo: voucher.validTo,
  };
}

/**
 * Gasta el voucher dentro de la transacción del cobro. La condición `status = ISSUED` va en el mismo
 * UPDATE: si dos cobros lo intentan a la vez, solo uno lo consigue y el otro se revierte.
 */
export async function redeemVoucher(tx: Prisma.TransactionClient, voucherId: string, tenantId: string, now = new Date()) {
  const { count } = await tx.hotelVoucher.updateMany({
    where: { id: voucherId, tenantId, status: VoucherStatus.ISSUED, validTo: { gte: now } },
    data: { status: VoucherStatus.REDEEMED, redeemedAt: now },
  });
  if (count !== 1) throw new ConflictException('Este voucher ya fue usado');
}
