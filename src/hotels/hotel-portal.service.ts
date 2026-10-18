import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { VoucherStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { HOTEL_TOKEN_TYPE } from './hotel-auth.guard';
import { normalizeCode } from './vouchers.logic';

// Estado que ve el hotel: un voucher sin usar cuya fecha pasó figura como vencido
export type VoucherView = 'ISSUED' | 'REDEEMED' | 'CANCELLED' | 'EXPIRED';

const RECENT = 100;

@Injectable()
export class HotelPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.hotelUser.findUnique({
      where: { email: (email ?? '').trim().toLowerCase() },
      include: { hotel: true },
    });
    // Mismo mensaje para usuario inexistente y clave incorrecta (no revela cuál falló)
    const ok = user && user.active && (await bcrypt.compare(password ?? '', user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Email o contraseña incorrectos');
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id, typ: HOTEL_TOKEN_TYPE }),
      user: { id: user.id, email: user.email, name: user.name, hotelName: user.hotel.name },
    };
  }

  /**
   * Todo lo que ve el hotel: su código vigente, cuántos vouchers se emitieron y se usaron (en total y por
   * restaurante) y los últimos pedidos. No incluye ventas ni consumos: eso es del restaurante.
   */
  async summary(hotelId: string, now = new Date()) {
    const hotel = await this.prisma.hotel.findUnique({ where: { id: hotelId } });
    if (!hotel) throw new NotFoundException('Hotel no encontrado');

    const [grouped, recent] = await Promise.all([
      this.prisma.hotelVoucher.groupBy({ by: ['tenantId', 'status'], where: { hotelId }, _count: true }),
      this.prisma.hotelVoucher.findMany({
        where: { hotelId },
        orderBy: { createdAt: 'desc' },
        take: RECENT,
        include: { tenant: { select: { name: true } } },
      }),
    ]);
    // Los vencidos hay que contarlos aparte: siguen figurando como ISSUED en la base
    const expiredByTenant = await this.prisma.hotelVoucher.groupBy({
      by: ['tenantId'],
      where: { hotelId, status: VoucherStatus.ISSUED, validTo: { lt: now } },
      _count: true,
    });
    const tenantIds = [...new Set(grouped.map((g) => g.tenantId))];
    const names = new Map(
      (await this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]),
    );

    const rows = new Map<string, { name: string; issued: number; redeemed: number }>();
    const totals = { issued: 0, redeemed: 0, cancelled: 0, expired: 0 };
    for (const g of grouped) {
      const row = rows.get(g.tenantId) ?? { name: names.get(g.tenantId) ?? 'Restaurante', issued: 0, redeemed: 0 };
      row.issued += g._count; // todo lo emitido, sin importar cómo terminó
      if (g.status === VoucherStatus.REDEEMED) {
        row.redeemed += g._count;
        totals.redeemed += g._count;
      }
      if (g.status === VoucherStatus.CANCELLED) totals.cancelled += g._count;
      totals.issued += g._count;
      rows.set(g.tenantId, row);
    }
    totals.expired = expiredByTenant.reduce((n, e) => n + e._count, 0);

    return {
      hotel: {
        name: hotel.name,
        slug: hotel.slug,
        accessCode: hotel.accessCode,
        voucherValidDays: hotel.voucherValidDays,
        active: hotel.active,
      },
      totals,
      byRestaurant: [...rows.values()].sort((a, b) => b.redeemed - a.redeemed || b.issued - a.issued),
      // El hotel no necesita ver los códigos de los vouchers: con el nombre y el restaurante le alcanza
      recent: recent.map((v) => ({
        id: v.id,
        guestName: v.guestName,
        restaurantName: v.tenant.name,
        status: this.view(v.status, v.validTo, now),
        createdAt: v.createdAt,
        validTo: v.validTo,
        redeemedAt: v.redeemedAt,
      })),
    };
  }

  // El hotel cambia el código que reparte a sus huéspedes. Los vouchers ya emitidos siguen valiendo.
  async setAccessCode(hotelId: string, raw: string) {
    const accessCode = (raw ?? '').trim();
    if (normalizeCode(accessCode).length < 4) throw new BadRequestException('El código tiene que tener al menos 4 letras o números');
    if (accessCode.length > 40) throw new BadRequestException('El código es demasiado largo');
    await this.prisma.hotel.update({ where: { id: hotelId }, data: { accessCode } });
    return { accessCode };
  }

  // Anula un voucher que todavía no se usó (por ejemplo, si lo pidió alguien que no estaba alojado)
  async cancelVoucher(hotelId: string, voucherId: string) {
    const { count } = await this.prisma.hotelVoucher.updateMany({
      where: { id: voucherId, hotelId, status: VoucherStatus.ISSUED },
      data: { status: VoucherStatus.CANCELLED },
    });
    if (!count) throw new NotFoundException('Ese voucher no existe o ya fue usado');
    return { id: voucherId, status: 'CANCELLED' as const };
  }

  private view(status: VoucherStatus, validTo: Date, now: Date): VoucherView {
    if (status === VoucherStatus.ISSUED && validTo < now) return 'EXPIRED';
    return status;
  }
}
