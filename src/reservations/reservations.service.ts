import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Reservation, ReservationSource, ReservationStatus, Tenant, WaitlistStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  Occupying,
  ReservationRules,
  availability,
  checkDay,
  enoughNotice,
  fits,
  isValidDay,
  localNow,
  minToTime,
  newReservationCode,
  normalizePhone,
  samePhone,
  slotTimes,
  timeToMin,
} from './reservations.logic';

// Cuántas reservas vigentes (hoy o a futuro) puede tener un mismo teléfono en un restaurante
export const MAX_ACTIVE_PER_PHONE = 3;
// Cuántas anotaciones en la lista de espera puede tener a la vez un mismo teléfono
export const MAX_WAITING_PER_PHONE = 2;

// Las reservas que ocupan lugar: las canceladas y las de quien no vino liberan la mesa
const OCCUPYING: ReservationStatus[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.ARRIVED];

export interface BookInput {
  date: string;
  startMin: number;
  partySize: number;
  guestName: string;
  guestPhone: string;
  guestEmail?: string;
  notes?: string;
  source: ReservationSource;
  hotelId?: string | null;
  voucherId?: string | null;
}

export interface BookOptions {
  // Público: se aplican todas las reglas del local. Manual: el personal puede reservar fuera de horario
  enforceRules: boolean;
  // El personal puede reservar aunque se pase de la capacidad ("reservar igual")
  enforceCapacity: boolean;
  now?: Date;
}

export const rulesOf = (t: Tenant): ReservationRules => ({
  openMin: t.reservationOpenMin,
  closeMin: t.reservationCloseMin,
  days: t.reservationDays ?? [],
  slotMin: t.reservationSlotMin,
  durationMin: t.reservationDurationMin,
  capacity: t.reservationCapacity,
  maxParty: t.reservationMaxParty,
  advanceDays: t.reservationAdvanceDays,
  noticeMin: t.reservationNoticeMin,
});

export function mapReservation(r: Reservation & { table?: { name: string } | null }) {
  return {
    id: r.id,
    code: r.code,
    date: r.date,
    time: minToTime(r.startMin),
    startMin: r.startMin,
    partySize: r.partySize,
    guestName: r.guestName,
    guestPhone: r.guestPhone,
    guestEmail: r.guestEmail,
    notes: r.notes,
    status: r.status,
    source: r.source,
    tableId: r.tableId,
    tableName: r.table?.name ?? null,
    hotelId: r.hotelId,
    voucherId: r.voucherId,
  };
}

// Qué estados se pueden alcanzar desde cada uno (una cancelada no se revive: se carga una nueva)
const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['ARRIVED', 'NO_SHOW', 'CANCELLED'],
  ARRIVED: ['CONFIRMED'],
  NO_SHOW: ['CONFIRMED'],
  CANCELLED: [],
};

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------------------------
  // Pantalla pública del restaurante
  // ---------------------------------------------------------------------------------------------

  async tenantBySlug(slug: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({ where: { reservationSlug: slug } });
    if (!tenant || !tenant.reservationsEnabled) throw new NotFoundException('Este restaurante no recibe reservas por acá');
    return tenant;
  }

  async publicInfo(slug: string) {
    const t = await this.tenantBySlug(slug);
    return {
      name: t.name,
      address: t.address,
      city: t.city,
      phone: t.phone,
      logoUrl: t.logoUrl,
      slotMin: t.reservationSlotMin,
      durationMin: t.reservationDurationMin,
      maxParty: t.reservationMaxParty,
      advanceDays: t.reservationAdvanceDays,
      days: t.reservationDays ?? [],
      open: minToTime(t.reservationOpenMin),
      close: minToTime(t.reservationCloseMin),
    };
  }

  // Los horarios de un día, con cuáles tienen lugar para esa cantidad de personas
  async availabilityFor(tenant: Tenant, day: string, partySize: number, now = new Date()) {
    if (!isValidDay(day)) throw new BadRequestException('La fecha no es válida');
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > tenant.reservationMaxParty) {
      throw new BadRequestException(`Se puede reservar para entre 1 y ${tenant.reservationMaxParty} personas`);
    }
    const rules = rulesOf(tenant);
    const clock = localNow(tenant.timezone, now);
    const check = checkDay(day, rules, clock);
    if (!check.ok) return { date: day, closed: check.reason, slots: [], full: false };

    const existing = await this.occupyingOn(tenant.id, day);
    const slots = availability(existing, day, partySize, rules, clock);
    // si ningún horario tiene lugar por estar lleno (no por falta de anticipación), se ofrece la lista de espera
    const full = slots.length > 0 && slots.every((s) => !s.available) && slots.some((s) => s.reason === 'LLENO');
    return { date: day, closed: null, slots, full };
  }

  async publicAvailability(slug: string, day: string, partySize: number, now = new Date()) {
    return this.availabilityFor(await this.tenantBySlug(slug), day, partySize, now);
  }

  async publicBook(
    slug: string,
    input: { date: string; time: string; partySize: number; guestName: string; guestPhone: string; guestEmail?: string; notes?: string },
    now = new Date(),
  ) {
    const tenant = await this.tenantBySlug(slug);
    const startMin = timeToMin(input.time);
    if (startMin === null) throw new BadRequestException('El horario no es válido');
    const reservation = await this.book(
      tenant,
      { ...input, startMin, source: ReservationSource.WEB },
      { enforceRules: true, enforceCapacity: true, now },
    );
    return this.confirmationOf(tenant, reservation);
  }

  // La reserva se cancela con su código y el teléfono con el que se hizo
  async publicCancel(slug: string, code: string, phone: unknown) {
    const tenant = await this.tenantBySlug(slug);
    const reservation = await this.prisma.reservation.findUnique({
      where: { tenantId_code: { tenantId: tenant.id, code: String(code ?? '').trim().toUpperCase() } },
    });
    if (!reservation || !samePhone(reservation.guestPhone, phone)) {
      // el mismo mensaje en los dos casos: no se revela si el código existe
      throw new NotFoundException('No encontramos una reserva con ese código y teléfono');
    }
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
      throw new BadRequestException('Esa reserva ya no se puede cancelar');
    }
    await this.prisma.reservation.update({ where: { id: reservation.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    return { message: 'Reserva cancelada' };
  }

  // Cuando no hay lugar, el cliente se anota para que el local le avise si se libera
  async publicWaitlist(
    slug: string,
    input: { date: string; fromTime: string; toTime: string; partySize: number; guestName: string; guestPhone: string; hotelId?: string | null },
    now = new Date(),
  ) {
    const tenant = await this.tenantBySlug(slug);
    return this.joinWaitlist(tenant, input, now);
  }

  async joinWaitlist(
    tenant: Tenant,
    input: { date: string; fromTime: string; toTime: string; partySize: number; guestName: string; guestPhone: string; hotelId?: string | null },
    now = new Date(),
  ) {
    const rules = rulesOf(tenant);
    if (!isValidDay(input.date)) throw new BadRequestException('La fecha no es válida');
    const check = checkDay(input.date, rules, localNow(tenant.timezone, now));
    if (!check.ok) throw new BadRequestException(this.dayProblem(check.reason));
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > rules.maxParty) {
      throw new BadRequestException(`Se puede reservar para entre 1 y ${rules.maxParty} personas`);
    }
    const from = timeToMin(input.fromTime);
    const to = timeToMin(input.toTime);
    if (from === null || to === null || from > to) throw new BadRequestException('El rango de horarios no es válido');
    const name = this.cleanName(input.guestName);
    const phone = normalizePhone(input.guestPhone);
    if (!phone) throw new BadRequestException('Escribí un teléfono válido (con código de área)');

    const waiting = await this.prisma.waitlistEntry.count({
      where: { tenantId: tenant.id, guestPhone: phone, status: WaitlistStatus.WAITING },
    });
    if (waiting >= MAX_WAITING_PER_PHONE) {
      throw new BadRequestException('Ya estás en la lista de espera. Si querés cambiarla, avisá al restaurante.');
    }
    await this.prisma.waitlistEntry.create({
      data: { tenantId: tenant.id, date: input.date, fromMin: from, toMin: to, partySize: input.partySize, guestName: name, guestPhone: phone, hotelId: input.hotelId ?? null },
    });
    return { message: 'Listo, te anotamos en la lista de espera. Si se libera un lugar, el restaurante te avisa.' };
  }

  // ---------------------------------------------------------------------------------------------
  // Núcleo: crear una reserva (lo usan la página pública, el personal y la pantalla del hotel)
  // ---------------------------------------------------------------------------------------------

  async book(tenant: Tenant, input: BookInput, opts: BookOptions): Promise<Reservation> {
    const now = opts.now ?? new Date();
    const rules = rulesOf(tenant);
    const clock = localNow(tenant.timezone, now);

    if (!isValidDay(input.date)) throw new BadRequestException('La fecha no es válida');
    const name = this.cleanName(input.guestName);
    const phone = normalizePhone(input.guestPhone);
    if (!phone) throw new BadRequestException('Escribí un teléfono válido (con código de área)');
    const maxParty = opts.enforceRules ? rules.maxParty : Math.max(rules.maxParty, rules.capacity);
    if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > maxParty) {
      throw new BadRequestException(`Se puede reservar para entre 1 y ${maxParty} personas`);
    }
    if (!Number.isInteger(input.startMin) || input.startMin < 0 || input.startMin >= 24 * 60) {
      throw new BadRequestException('El horario no es válido');
    }

    if (opts.enforceRules) {
      const check = checkDay(input.date, rules, clock);
      if (!check.ok) throw new BadRequestException(this.dayProblem(check.reason));
      if (!slotTimes(rules).includes(input.startMin)) throw new BadRequestException('Ese horario no está disponible');
      if (!enoughNotice(input.date, input.startMin, rules, clock)) {
        throw new BadRequestException('Ya es muy tarde para reservar ese horario. Llamá al restaurante.');
      }
      const active = await this.prisma.reservation.count({
        where: { tenantId: tenant.id, guestPhone: phone, status: { in: ['PENDING', 'CONFIRMED'] }, date: { gte: clock.day } },
      });
      if (active >= MAX_ACTIVE_PER_PHONE) {
        throw new BadRequestException('Ya tenés reservas vigentes en este restaurante. Cancelá alguna o llamá para modificarla.');
      }
    } else if (input.date < clock.day) {
      throw new BadRequestException('No se puede reservar en una fecha pasada');
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Los pedidos del mismo día se atienden de a uno: dos personas no pueden quedarse con el último lugar
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reserva:${tenant.id}:${input.date}`}))`;
          if (opts.enforceCapacity) {
            const existing = await this.occupyingOn(tenant.id, input.date, tx);
            if (!fits(existing, input.startMin, input.partySize, rules)) {
              throw new ConflictException({ message: 'Ese horario ya no tiene lugar', code: 'LLENO' });
            }
          }
          return tx.reservation.create({
            data: {
              tenantId: tenant.id,
              date: input.date,
              startMin: input.startMin,
              partySize: input.partySize,
              guestName: name,
              guestPhone: phone,
              guestEmail: (input.guestEmail ?? '').trim().slice(0, 120),
              notes: (input.notes ?? '').trim().slice(0, 300),
              status: ReservationStatus.CONFIRMED,
              source: input.source,
              code: newReservationCode(),
              hotelId: input.hotelId ?? null,
              voucherId: input.voucherId ?? null,
            },
          });
        });
      } catch (error) {
        const collision = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!collision) throw error;
      }
    }
    throw new BadRequestException('No se pudo registrar la reserva, probá de nuevo');
  }

  confirmationOf(tenant: Tenant, r: Reservation) {
    return {
      code: r.code,
      restaurantName: tenant.name,
      address: [tenant.address, tenant.city].filter(Boolean).join(', '),
      phone: tenant.phone,
      date: r.date,
      time: minToTime(r.startMin),
      partySize: r.partySize,
      guestName: r.guestName,
      status: r.status,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Lado del restaurante
  // ---------------------------------------------------------------------------------------------

  // Las reservas y la lista de espera de un día, con cuáles personas en espera ya tendrían lugar
  async listDay(tenantId: string, day: string, now = new Date()) {
    if (!isValidDay(day)) throw new BadRequestException('La fecha no es válida');
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const rules = rulesOf(tenant);
    const clock = localNow(tenant.timezone, now);

    const [rows, waiting] = await Promise.all([
      this.prisma.reservation.findMany({ where: { tenantId, date: day }, include: { table: { select: { name: true } } }, orderBy: [{ startMin: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.waitlistEntry.findMany({ where: { tenantId, date: day, status: { in: [WaitlistStatus.WAITING, WaitlistStatus.CONTACTED] } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const existing: Occupying[] = rows.filter((r) => OCCUPYING.includes(r.status)).map((r) => ({ startMin: r.startMin, partySize: r.partySize }));
    const live = rows.filter((r) => OCCUPYING.includes(r.status));

    return {
      date: day,
      summary: {
        reservations: live.length,
        guests: live.reduce((sum, r) => sum + r.partySize, 0),
        arrived: rows.filter((r) => r.status === 'ARRIVED').length,
        capacity: rules.capacity,
      },
      reservations: rows.map(mapReservation),
      waitlist: waiting.map((w) => ({
        id: w.id,
        guestName: w.guestName,
        guestPhone: w.guestPhone,
        partySize: w.partySize,
        from: minToTime(w.fromMin),
        to: minToTime(w.toMin),
        status: w.status,
        // ¿ya hay lugar en algún horario de su rango? (por ejemplo, porque se canceló una reserva)
        hasRoom: slotTimes(rules)
          .filter((m) => m >= w.fromMin && m <= w.toMin)
          .some((m) => enoughNotice(day, m, rules, clock) && fits(existing, m, w.partySize, rules)),
      })),
    };
  }

  async createManual(
    tenantId: string,
    input: { date: string; time: string; partySize: number; guestName: string; guestPhone: string; guestEmail?: string; notes?: string; force?: boolean },
    now = new Date(),
  ) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const startMin = timeToMin(input.time);
    if (startMin === null) throw new BadRequestException('El horario no es válido');
    const reservation = await this.book(
      tenant,
      { ...input, startMin, source: ReservationSource.MANUAL },
      { enforceRules: false, enforceCapacity: !input.force, now },
    );
    return mapReservation(reservation);
  }

  async update(
    tenantId: string,
    id: string,
    patch: { status?: ReservationStatus; tableId?: string | null; notes?: string; date?: string; time?: string; partySize?: number; force?: boolean },
  ) {
    const current = await this.prisma.reservation.findFirst({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('Reserva no encontrada');

    const data: Prisma.ReservationUpdateInput = {};

    if (patch.status && patch.status !== current.status) {
      if (!TRANSITIONS[current.status].includes(patch.status)) {
        throw new BadRequestException('Ese cambio de estado no se puede hacer');
      }
      data.status = patch.status;
      if (patch.status === 'CANCELLED') data.cancelledAt = new Date();
    }

    if (patch.tableId !== undefined) {
      if (patch.tableId === null || patch.tableId === '') data.table = { disconnect: true };
      else {
        const table = await this.prisma.table.findFirst({ where: { id: patch.tableId, tenantId } });
        if (!table) throw new NotFoundException('Mesa no encontrada');
        data.table = { connect: { id: table.id } };
      }
    }
    if (patch.notes !== undefined) data.notes = patch.notes.trim().slice(0, 300);

    // Cambiar fecha, hora o cantidad: se vuelve a verificar que haya lugar (sin contarse a sí misma)
    const moving = patch.date !== undefined || patch.time !== undefined || patch.partySize !== undefined;
    if (moving) {
      const date = patch.date ?? current.date;
      const startMin = patch.time !== undefined ? timeToMin(patch.time) : current.startMin;
      const partySize = patch.partySize ?? current.partySize;
      if (!isValidDay(date) || startMin === null) throw new BadRequestException('La fecha o el horario no son válidos');
      if (!Number.isInteger(partySize) || partySize < 1) throw new BadRequestException('La cantidad de personas no es válida');
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (!patch.force && OCCUPYING.includes((data.status as ReservationStatus) ?? current.status)) {
        // se saca la propia reserva de lo que ocupa lugar
        const others = await this.prisma.reservation.findMany({
          where: { tenantId, date, status: { in: OCCUPYING }, id: { not: id } },
          select: { startMin: true, partySize: true },
        });
        if (!fits(others, startMin, partySize, rulesOf(tenant))) {
          throw new ConflictException({ message: 'Ese horario no tiene lugar para esa cantidad de personas', code: 'LLENO' });
        }
      }
      data.date = date;
      data.startMin = startMin;
      data.partySize = partySize;
    }

    const updated = await this.prisma.reservation.update({ where: { id }, data, include: { table: { select: { name: true } } } });
    return mapReservation(updated);
  }

  async updateWaitlist(tenantId: string, id: string, status: WaitlistStatus) {
    const entry = await this.prisma.waitlistEntry.findFirst({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException('No encontrado');
    await this.prisma.waitlistEntry.update({ where: { id }, data: { status } });
    return { message: 'Listo' };
  }

  // Pasa a alguien de la lista de espera a una reserva en el horario que se le ofrezca
  async bookFromWaitlist(tenantId: string, id: string, time: string, now = new Date()) {
    const entry = await this.prisma.waitlistEntry.findFirst({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException('No encontrado');
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const startMin = timeToMin(time);
    if (startMin === null) throw new BadRequestException('El horario no es válido');
    const reservation = await this.book(
      tenant,
      {
        date: entry.date,
        startMin,
        partySize: entry.partySize,
        guestName: entry.guestName,
        guestPhone: entry.guestPhone,
        source: ReservationSource.MANUAL,
        hotelId: entry.hotelId,
      },
      { enforceRules: false, enforceCapacity: true, now },
    );
    await this.prisma.waitlistEntry.update({ where: { id }, data: { status: WaitlistStatus.BOOKED } });
    return mapReservation(reservation);
  }

  // ---------------------------------------------------------------------------------------------

  private async occupyingOn(tenantId: string, day: string, tx: Prisma.TransactionClient | PrismaService = this.prisma): Promise<Occupying[]> {
    const rows = await tx.reservation.findMany({
      where: { tenantId, date: day, status: { in: OCCUPYING } },
      select: { startMin: true, partySize: true },
    });
    return rows;
  }

  private cleanName(raw: string): string {
    const name = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 60) throw new BadRequestException('Escribí tu nombre');
    return name;
  }

  private dayProblem(reason?: 'PASADO' | 'LEJOS' | 'DIA_CERRADO'): string {
    if (reason === 'PASADO') return 'Esa fecha ya pasó';
    if (reason === 'LEJOS') return 'Todavía no se pueden hacer reservas para una fecha tan lejana';
    return 'El restaurante no recibe reservas ese día';
  }
}
