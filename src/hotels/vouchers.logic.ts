import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient, VoucherStatus } from '@prisma/client';
import { createHmac, randomInt } from 'crypto';

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

// ---- Documento del huésped (DNI o pasaporte) ----

// Sin puntos, espacios ni guiones y en mayúsculas: "30.123.456" y "30123456" son el mismo documento
export const normalizeDocument = (raw: unknown) =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

// DNI (7-8 dígitos) o pasaporte (letras y números, hasta 20)
export const isValidDocument = (doc: string) => /^[A-Z0-9]{5,20}$/.test(doc);

// Para comparar nombres sin importar mayúsculas, tildes ni espacios de más
export const normalizeName = (raw: unknown) =>
  String(raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// El número de documento no se guarda: solo una huella cifrada con una clave del servidor (HMAC). Sirve para
// reconocer al mismo huésped, y aunque se filtrara la base no se puede volver al número sin esa clave.
// (Si se cambia la clave, las huellas anteriores dejan de coincidir.)
const documentKey = () => process.env.VOUCHER_DOC_KEY || process.env.JWT_SECRET || 'solo-para-pruebas';

export const documentHash = (doc: string) =>
  createHmac('sha256', createHmac('sha256', documentKey()).update('tavolapp:guest-document').digest())
    .update(doc)
    .digest('hex');

// Últimos 3 caracteres: el cajero puede pedirle al huésped que los confirme
export const documentHint = (doc: string) => doc.slice(-3);

type Db = PrismaClient | Prisma.TransactionClient;

export interface ValidVoucher {
  id: string;
  code: string;
  hotelId: string;
  hotelName: string;
  guestName: string;
  // Últimos caracteres del documento del huésped (null en vouchers anteriores a este dato)
  documentHint: string | null;
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
    documentHint: voucher.guestDocHint,
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
