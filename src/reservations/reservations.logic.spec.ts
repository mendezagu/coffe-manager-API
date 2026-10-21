import {
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
  slugify,
  timeToMin,
  validateRules,
  weekdayOf,
} from './reservations.logic';

const rules: ReservationRules = {
  openMin: 12 * 60,
  closeMin: 23 * 60,
  days: [0, 1, 2, 3, 4, 5, 6],
  slotMin: 30,
  durationMin: 90,
  capacity: 10,
  maxParty: 8,
  advanceDays: 30,
  noticeMin: 60,
};

describe('reservas: horarios y fechas', () => {
  it('convierte entre "HH:MM" y minutos', () => {
    expect(timeToMin('20:30')).toBe(1230);
    expect(timeToMin('9:05')).toBe(545);
    expect(timeToMin('24:00')).toBeNull();
    expect(timeToMin('abc')).toBeNull();
    expect(minToTime(1230)).toBe('20:30');
    expect(minToTime(65)).toBe('01:05');
  });

  it('valida días reales y calcula el día de la semana sin zona horaria', () => {
    expect(isValidDay('2026-10-10')).toBe(true);
    expect(isValidDay('2026-02-30')).toBe(false);
    expect(isValidDay('10/10/2026')).toBe(false);
    expect(weekdayOf('2026-10-10')).toBe(6); // sábado
  });

  it('localNow da el día y la hora de la zona del negocio', () => {
    // 02:30 UTC del 10/10 son las 23:30 del 9/10 en Buenos Aires
    expect(localNow('America/Argentina/Buenos_Aires', new Date('2026-10-10T02:30:00Z'))).toEqual({ day: '2026-10-09', min: 23 * 60 + 30 });
    expect(localNow('UTC', new Date('2026-10-10T02:30:00Z'))).toEqual({ day: '2026-10-10', min: 150 });
  });

  it('ofrece un horario cada tanto, desde la apertura hasta el último', () => {
    const slots = slotTimes(rules);
    expect(slots[0]).toBe(720);
    expect(slots[slots.length - 1]).toBe(1380);
    expect(slots.length).toBe(23);
  });
});

describe('reservas: lugar disponible', () => {
  it('no deja pasarse de la capacidad en ningún momento de la reserva', () => {
    const existing = [{ startMin: 20 * 60, partySize: 6 }];
    expect(fits(existing, 20 * 60, 4, rules)).toBe(true); // 6 + 4 = 10
    expect(fits(existing, 20 * 60, 5, rules)).toBe(false);
    // más tarde, cuando la primera ya terminó (20:00 + 90 min = 21:30), vuelve a haber lugar
    expect(fits(existing, 21 * 60 + 30, 8, rules)).toBe(true);
    // pero a las 21:00 todavía se superponen
    expect(fits(existing, 21 * 60, 5, rules)).toBe(false);
  });

  it('una reserva que empieza antes y se superpone al final también cuenta', () => {
    const existing = [{ startMin: 21 * 60, partySize: 8 }];
    expect(fits(existing, 20 * 60, 3, rules)).toBe(false); // 20:00 a 21:30 se cruza con la de las 21:00
    expect(fits(existing, 19 * 60 + 30, 3, rules)).toBe(true); // termina justo a las 21:00
  });

  it('availability marca lleno y falta de anticipación', () => {
    const existing = [{ startMin: 20 * 60, partySize: 10 }];
    const now = { day: '2026-10-10', min: 19 * 60 + 30 }; // son las 19:30
    const slots = availability(existing, '2026-10-10', 2, rules, now);
    const at = (t: string) => slots.find((s) => s.time === t)!;
    expect(at('19:00')).toMatchObject({ available: false, reason: 'ANTICIPACION' });
    expect(at('20:30')).toMatchObject({ available: false, reason: 'LLENO' }); // 20:30 ya cumple la anticipación, pero está lleno
    expect(at('22:30')).toMatchObject({ available: true });
  });

  it('la anticipación mínima solo importa el mismo día', () => {
    const now = { day: '2026-10-10', min: 20 * 60 };
    expect(enoughNotice('2026-10-11', 12 * 60, rules, now)).toBe(true);
    expect(enoughNotice('2026-10-10', 20 * 60 + 30, rules, now)).toBe(false);
    expect(enoughNotice('2026-10-10', 21 * 60, rules, now)).toBe(true);
  });

  it('checkDay: no se reserva en el pasado, ni muy lejos, ni un día que el local no atiende', () => {
    const now = { day: '2026-10-10', min: 600 };
    expect(checkDay('2026-10-09', rules, now)).toEqual({ ok: false, reason: 'PASADO' });
    expect(checkDay('2026-10-10', rules, now).ok).toBe(true);
    expect(checkDay('2026-12-31', rules, now)).toEqual({ ok: false, reason: 'LEJOS' });
    const sinLunes = { ...rules, days: [0, 2, 3, 4, 5, 6] };
    expect(checkDay('2026-10-12', sinLunes, now)).toEqual({ ok: false, reason: 'DIA_CERRADO' }); // lunes
  });
});

describe('reservas: datos', () => {
  it('normaliza teléfonos y compara por los últimos dígitos', () => {
    expect(normalizePhone('+54 9 3546 12-3456')).toBe('5493546123456');
    expect(normalizePhone('123')).toBeNull();
    expect(samePhone('5493546123456', '3546 12-3456')).toBe(true);
    expect(samePhone('5493546123456', '999999')).toBe(false);
    expect(samePhone('5493546123456', '123')).toBe(false);
  });

  it('el código de reserva tiene 6 caracteres sin letras que se confunden', () => {
    for (let i = 0; i < 50; i++) expect(newReservationCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('slugify saca tildes y signos', () => {
    expect(slugify('Café del Centro!')).toBe('cafe-del-centro');
    expect(slugify('  ¡¡¡  ')).toBe('restaurante');
  });

  it('valida que las reglas tengan sentido', () => {
    expect(validateRules(rules)).toBeNull();
    expect(validateRules({ ...rules, slotMin: 20 })).toMatch(/15, 30 o 60/);
    expect(validateRules({ ...rules, openMin: 1400, closeMin: 1300 })).toMatch(/anterior/);
    expect(validateRules({ ...rules, maxParty: 20 })).toMatch(/capacidad/);
    expect(validateRules({ ...rules, days: [] })).toMatch(/día/);
    expect(validateRules({ ...rules, days: [9] })).toMatch(/día/);
  });
});
