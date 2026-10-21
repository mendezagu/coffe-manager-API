import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient, ReservationSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { HotelsService } from './hotels.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Hoteles: reservar mesa desde la pantalla del huésped', () => {
  let prisma: PrismaService;
  let hotels: HotelsService;
  let tenantId: string;
  let hotelId: string;

  // Un lunes a media mañana (hora de Buenos Aires) y la reserva dos días después
  const NOW = new Date('2030-06-10T15:00:00Z');
  const DATE = '2030-06-12';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    hotels = new HotelsService(prisma, new ReservationsService(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    await prisma.hotel.deleteMany({});
    tenantId = (
      await prisma.tenant.create({
        data: {
          name: 'Pizzería',
          requireOpenRegister: false,
          reservationsEnabled: true,
          reservationSlug: 'pizzeria',
          reservationDays: [0, 1, 2, 3, 4, 5, 6],
          reservationCapacity: 10,
          reservationNoticeMin: 0,
        },
      })
    ).id;
    hotelId = (await prisma.hotel.create({ data: { name: 'Hotel Alpes', slug: 'alpes', accessCode: 'ALPES-OCT' } })).id;
    await prisma.hotelPartner.create({ data: { hotelId, tenantId, discountPct: 10 } });
  });

  const reserve = (over: Record<string, unknown> = {}) =>
    hotels.reserve(
      'alpes',
      { tenantId, accessCode: 'ALPES-OCT', date: DATE, time: '21:00', partySize: 2, guestName: 'Lucía Pérez', guestPhone: '+54 9 11 5555-1234', ...over },
      NOW,
    );

  it('reserva sin voucher: queda a nombre del hotel y sin descuento', async () => {
    const r = await reserve();

    expect(r.voucher).toBeNull();
    expect(r.reservation.time).toBe('21:00');
    const row = await prisma.reservation.findFirstOrThrow({ where: { tenantId } });
    expect(row.source).toBe(ReservationSource.HOTEL);
    expect(row.hotelId).toBe(hotelId);
    expect(row.voucherId).toBeNull();
    expect(await prisma.hotelVoucher.count()).toBe(0);
  });

  it('reserva con voucher: lo emite y lo deja vinculado a la reserva', async () => {
    const r = await reserve({ wantVoucher: true, document: '30123456' });

    expect(r.voucher?.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(r.voucher?.discountPct).toBe(10);
    const row = await prisma.reservation.findFirstOrThrow({ where: { tenantId } });
    const voucher = await prisma.hotelVoucher.findUniqueOrThrow({ where: { code: r.voucher!.code } });
    expect(row.voucherId).toBe(voucher.id);
  });

  it('una segunda reserva con el mismo voucher vigente lo reutiliza pero no lo vincula dos veces', async () => {
    const a = await reserve({ wantVoucher: true, document: '30123456' });
    const b = await reserve({ wantVoucher: true, document: '30123456', time: '22:00' });

    expect(b.voucher?.code).toBe(a.voucher?.code);
    expect(b.voucher?.reused).toBe(true);
    expect(await prisma.hotelVoucher.count()).toBe(1);
    const linked = await prisma.reservation.count({ where: { tenantId, voucherId: { not: null } } });
    expect(linked).toBe(1);
  });

  it('pedir voucher sin documento válido no crea la reserva', async () => {
    await expect(reserve({ wantVoucher: true, document: '12' })).rejects.toThrow(BadRequestException);
    expect(await prisma.reservation.count()).toBe(0);
  });

  it('exige el código vigente del hotel', async () => {
    await expect(reserve({ accessCode: 'OTRO' })).rejects.toThrow(ForbiddenException);
    expect(await prisma.reservation.count()).toBe(0);
  });

  it('no deja reservar en un restaurante que no es del hotel o que apagó las reservas', async () => {
    const other = (await prisma.tenant.create({ data: { name: 'Parrilla', requireOpenRegister: false, reservationsEnabled: true } })).id;
    await expect(reserve({ tenantId: other })).rejects.toThrow(NotFoundException);

    await prisma.tenant.update({ where: { id: tenantId }, data: { reservationsEnabled: false } });
    await expect(reserve()).rejects.toThrow(NotFoundException);
    expect((await hotels.publicInfo('alpes')).restaurants[0].reservable).toBe(false);
  });

  it('respeta la capacidad: si no hay lugar responde "lleno" y la lista de espera lo anota con el hotel', async () => {
    await reserve({ partySize: 10, guestPhone: '1155550001' });

    await expect(reserve({ guestPhone: '1155550002' })).rejects.toThrow(ConflictException);

    await hotels.reserveWaitlist(
      'alpes',
      { tenantId, accessCode: 'ALPES-OCT', date: DATE, fromTime: '20:00', toTime: '22:00', partySize: 2, guestName: 'Ana Gómez', guestPhone: '1155550002' },
      NOW,
    );
    const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { tenantId } });
    expect(entry.hotelId).toBe(hotelId);
  });

  it('el horario con lugar se consulta sin pedir el código del hotel', async () => {
    const a = await hotels.reservationAvailability('alpes', tenantId, DATE, 2, NOW);
    expect(a.closed).toBeNull();
    expect(a.slots.find((s) => s.time === '21:00')?.available).toBe(true);
  });
});
