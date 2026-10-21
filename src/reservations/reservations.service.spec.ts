import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_ACTIVE_PER_PHONE, ReservationsService } from './reservations.service';

// Corre contra la base de pruebas (coffee_manager_test), nunca contra la de desarrollo.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

// Sábado 10/10/2026, 12:00 en Buenos Aires
const NOW = new Date('2026-10-10T15:00:00Z');
const TODAY = '2026-10-10';
const TOMORROW = '2026-10-11';

describe('ReservationsService', () => {
  let prisma: PrismaService;
  let service: ReservationsService;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    service = new ReservationsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (
      await prisma.tenant.create({
        data: {
          name: 'Resto A',
          reservationsEnabled: true,
          reservationSlug: 'resto-a',
          reservationOpenMin: 12 * 60,
          reservationCloseMin: 23 * 60,
          reservationSlotMin: 30,
          reservationDurationMin: 90,
          reservationCapacity: 10,
          reservationMaxParty: 8,
          reservationNoticeMin: 60,
        },
      })
    ).id;
  });

  let n = 0;
  const guest = (over: Partial<{ date: string; time: string; partySize: number; guestName: string; guestPhone: string }> = {}) => ({
    date: TOMORROW,
    time: '21:00',
    partySize: 2,
    guestName: 'Ana Pérez',
    guestPhone: `35461234${String(10 + ++n).padStart(2, '0')}`,
    ...over,
  });

  describe('página pública', () => {
    it('solo funciona con las reservas activadas', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { reservationsEnabled: false } });
      await expect(service.publicInfo('resto-a')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.publicInfo('no-existe')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reserva y devuelve un código; la reserva queda confirmada', async () => {
      const r = await service.publicBook('resto-a', guest(), NOW);
      expect(r.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(r).toMatchObject({ date: TOMORROW, time: '21:00', partySize: 2, restaurantName: 'Resto A', status: 'CONFIRMED' });
      expect(await prisma.reservation.count({ where: { tenantId } })).toBe(1);
    });

    it('rechaza horarios que no existen, días pasados y reservas demasiado sobre la hora', async () => {
      await expect(service.publicBook('resto-a', guest({ time: '21:10' }), NOW)).rejects.toThrow(/horario/);
      await expect(service.publicBook('resto-a', guest({ date: '2026-10-09' }), NOW)).rejects.toThrow(/pasó/);
      // son las 12:00 y se exige 1 hora de anticipación
      await expect(service.publicBook('resto-a', guest({ date: TODAY, time: '12:30' }), NOW)).rejects.toThrow(/tarde/);
      await expect(service.publicBook('resto-a', guest({ date: TODAY, time: '13:00' }), NOW)).resolves.toBeDefined();
    });

    it('respeta los días en que el local atiende y el máximo por reserva', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { reservationDays: [6] } }); // solo sábados
      await expect(service.publicBook('resto-a', guest({ date: TOMORROW }), NOW)).rejects.toThrow(/ese día/); // domingo
      await expect(service.publicBook('resto-a', guest({ date: TODAY, time: '14:00', partySize: 9 }), NOW)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no deja pasarse de la capacidad: el último lugar se lo queda uno solo, aunque lleguen a la vez', async () => {
      // capacidad 10: caben dos reservas de 4, la tercera no
      const results = await Promise.allSettled([
        service.publicBook('resto-a', guest({ partySize: 4 }), NOW),
        service.publicBook('resto-a', guest({ partySize: 4 }), NOW),
        service.publicBook('resto-a', guest({ partySize: 4 }), NOW),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      expect(await prisma.reservation.count({ where: { tenantId } })).toBe(2);
    });

    it('un mismo teléfono tiene un tope de reservas vigentes', async () => {
      const phone = '3546999999';
      for (let i = 0; i < MAX_ACTIVE_PER_PHONE; i++) {
        await service.publicBook('resto-a', guest({ guestPhone: phone, time: `1${3 + i}:00` }), NOW);
      }
      await expect(service.publicBook('resto-a', guest({ guestPhone: phone, time: '20:00' }), NOW)).rejects.toThrow(/vigentes/);
    });

    it('los horarios muestran qué tiene lugar y avisa cuando todo el día está lleno', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { reservationCapacity: 4, reservationMaxParty: 4, reservationOpenMin: 20 * 60, reservationCloseMin: 20 * 60 } });
      const before = await service.publicAvailability('resto-a', TOMORROW, 4, NOW);
      expect(before.slots).toEqual([{ time: '20:00', available: true }]);
      expect(before.full).toBe(false);

      await service.publicBook('resto-a', guest({ time: '20:00', partySize: 4 }), NOW);
      const after = await service.publicAvailability('resto-a', TOMORROW, 2, NOW);
      expect(after.slots[0]).toMatchObject({ available: false, reason: 'LLENO' });
      expect(after.full).toBe(true);
    });

    it('un día que no se puede reservar devuelve el motivo, no un error', async () => {
      const r = await service.publicAvailability('resto-a', '2026-10-09', 2, NOW);
      expect(r).toMatchObject({ closed: 'PASADO', slots: [] });
    });

    it('se cancela con el código y el teléfono; con otro teléfono no', async () => {
      const phone = '3546123456';
      const { code } = await service.publicBook('resto-a', guest({ guestPhone: phone }), NOW);
      await expect(service.publicCancel('resto-a', code, '3546000000')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.publicCancel('resto-a', 'XXXXXX', phone)).rejects.toBeInstanceOf(NotFoundException);
      await service.publicCancel('resto-a', code.toLowerCase(), phone);
      expect((await prisma.reservation.findFirstOrThrow({ where: { tenantId } })).status).toBe('CANCELLED');
      await expect(service.publicCancel('resto-a', code, phone)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('una reserva cancelada libera el lugar', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { reservationCapacity: 4, reservationMaxParty: 4 } });
      const phone = '3546123456';
      const { code } = await service.publicBook('resto-a', guest({ guestPhone: phone, partySize: 4 }), NOW);
      await expect(service.publicBook('resto-a', guest({ partySize: 2 }), NOW)).rejects.toBeInstanceOf(ConflictException);
      await service.publicCancel('resto-a', code, phone);
      await expect(service.publicBook('resto-a', guest({ partySize: 2 }), NOW)).resolves.toBeDefined();
    });
  });

  describe('lista de espera', () => {
    it('se anota y el local ve cuándo ya hay lugar', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { reservationCapacity: 4, reservationMaxParty: 4 } });
      const phone = '3546123456';
      const full = await service.publicBook('resto-a', guest({ guestPhone: phone, partySize: 4, time: '21:00' }), NOW);

      await service.publicWaitlist('resto-a', { date: TOMORROW, fromTime: '21:00', toTime: '21:30', partySize: 2, guestName: 'Luis', guestPhone: '3546888888' }, NOW);
      let day = await service.listDay(tenantId, TOMORROW, NOW);
      expect(day.waitlist).toHaveLength(1);
      expect(day.waitlist[0].hasRoom).toBe(false);

      await service.publicCancel('resto-a', full.code, phone);
      day = await service.listDay(tenantId, TOMORROW, NOW);
      expect(day.waitlist[0].hasRoom).toBe(true);
    });

    it('un teléfono no puede anotarse muchas veces', async () => {
      const body = { date: TOMORROW, fromTime: '21:00', toTime: '22:00', partySize: 2, guestName: 'Luis', guestPhone: '3546888888' };
      await service.publicWaitlist('resto-a', body, NOW);
      await service.publicWaitlist('resto-a', body, NOW);
      await expect(service.publicWaitlist('resto-a', body, NOW)).rejects.toThrow(/lista de espera/);
    });

    it('se puede pasar de la lista de espera a una reserva', async () => {
      await service.publicWaitlist('resto-a', { date: TOMORROW, fromTime: '21:00', toTime: '22:00', partySize: 3, guestName: 'Luis', guestPhone: '3546888888' }, NOW);
      const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { tenantId } });
      const reservation = await service.bookFromWaitlist(tenantId, entry.id, '21:30', NOW);
      expect(reservation).toMatchObject({ time: '21:30', partySize: 3, guestName: 'Luis' });
      expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('BOOKED');
    });
  });

  describe('lado del restaurante', () => {
    it('lista el día con el resumen de reservas y personas', async () => {
      await service.publicBook('resto-a', guest({ time: '20:00', partySize: 3 }), NOW);
      await service.publicBook('resto-a', guest({ time: '19:00', partySize: 2 }), NOW);
      const day = await service.listDay(tenantId, TOMORROW, NOW);
      expect(day.reservations.map((r) => r.time)).toEqual(['19:00', '20:00']); // en orden
      expect(day.summary).toMatchObject({ reservations: 2, guests: 5, capacity: 10 });
    });

    it('el personal puede cargar una reserva fuera de los horarios que se ofrecen en la web', async () => {
      const r = await service.createManual(tenantId, { ...guest({ time: '23:45' }) }, NOW);
      expect(r).toMatchObject({ time: '23:45', source: 'MANUAL' });
    });

    it('"reservar igual" deja pasarse de la capacidad; sin eso se avisa', async () => {
      await service.createManual(tenantId, guest({ partySize: 8, time: '21:00' }), NOW);
      await expect(service.createManual(tenantId, guest({ partySize: 8, time: '21:00' }), NOW)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.createManual(tenantId, { ...guest({ partySize: 8, time: '21:00' }), force: true }, NOW)).resolves.toBeDefined();
    });

    it('cambia de estado: llegó, no vino, cancelar; una cancelada no se revive', async () => {
      const created = await service.createManual(tenantId, guest(), NOW);
      expect((await service.update(tenantId, created.id, { status: 'ARRIVED' })).status).toBe('ARRIVED');
      expect((await service.update(tenantId, created.id, { status: 'CONFIRMED' })).status).toBe('CONFIRMED'); // se corrige un error
      expect((await service.update(tenantId, created.id, { status: 'CANCELLED' })).status).toBe('CANCELLED');
      await expect(service.update(tenantId, created.id, { status: 'CONFIRMED' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('asigna una mesa del negocio, pero no de otro', async () => {
      const table = await prisma.table.create({ data: { tenantId, name: 'Mesa 5' } });
      const otherTenant = await prisma.tenant.create({ data: { name: 'Otro' } });
      const foreign = await prisma.table.create({ data: { tenantId: otherTenant.id, name: 'Mesa X' } });
      const created = await service.createManual(tenantId, guest(), NOW);

      expect((await service.update(tenantId, created.id, { tableId: table.id })).tableName).toBe('Mesa 5');
      await expect(service.update(tenantId, created.id, { tableId: foreign.id })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('al cambiar horario o cantidad se verifica el lugar sin contarse a sí misma', async () => {
      const a = await service.createManual(tenantId, guest({ partySize: 6, time: '20:00' }), NOW);
      await service.createManual(tenantId, guest({ partySize: 4, time: '20:00' }), NOW); // 6 + 4 = 10, lleno
      // pasar la primera de 6 a 5 personas entra; a 7 no
      await expect(service.update(tenantId, a.id, { partySize: 5 })).resolves.toMatchObject({ partySize: 5 });
      await expect(service.update(tenantId, a.id, { partySize: 7 })).rejects.toBeInstanceOf(ConflictException);
    });

    it('nunca toca las reservas de otro negocio', async () => {
      const other = await prisma.tenant.create({ data: { name: 'Otro', reservationsEnabled: true, reservationSlug: 'otro' } });
      const foreign = await service.createManual(other.id, guest(), NOW);
      await expect(service.update(tenantId, foreign.id, { status: 'CANCELLED' })).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.listDay(tenantId, TOMORROW, NOW)).reservations).toHaveLength(0);
    });
  });
});
