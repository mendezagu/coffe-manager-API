// Reglas de las reservas, sin base de datos: horarios, disponibilidad y validaciones.
// Todo trabaja en hora LOCAL del negocio: el día es "YYYY-MM-DD" y la hora son minutos desde la medianoche.

export interface ReservationRules {
  openMin: number; // primer horario reservable
  closeMin: number; // último horario reservable
  days: number[]; // días de la semana en que se reserva (0 = domingo)
  slotMin: number; // cada cuántos minutos hay un horario
  durationMin: number; // cuánto ocupa una mesa una reserva
  capacity: number; // personas sentadas a la vez
  maxParty: number; // personas por reserva
  advanceDays: number; // con cuántos días de anticipación se puede reservar
  noticeMin: number; // anticipación mínima
}

// Una reserva que ocupa lugar (las canceladas y las que no vinieron no cuentan)
export interface Occupying {
  startMin: number;
  partySize: number;
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const timeToMin = (time: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
};

export const minToTime = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

// Día de la semana de una fecha "YYYY-MM-DD" (0 = domingo), sin depender de ninguna zona horaria
export const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

export function addDaysTo(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// El día y la hora que son ahora en la zona del negocio
export function localNow(timeZone: string, now = new Date()): { day: string; min: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, min: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Los horarios que se ofrecen en un día (sin mirar la ocupación)
export function slotTimes(rules: ReservationRules): number[] {
  const out: number[] = [];
  for (let m = rules.openMin; m <= rules.closeMin; m += rules.slotMin) out.push(m);
  return out;
}

// Personas sentadas a la vez en el minuto `at`
function seatedAt(existing: Occupying[], at: number, durationMin: number): number {
  return existing.filter((r) => r.startMin <= at && at < r.startMin + durationMin).reduce((sum, r) => sum + r.partySize, 0);
}

// ¿Cabe una reserva nueva? En ningún momento de su duración se pueden pasar de la capacidad.
export function fits(existing: Occupying[], startMin: number, partySize: number, rules: ReservationRules): boolean {
  for (let at = startMin; at < startMin + rules.durationMin; at += 5) {
    if (seatedAt(existing, at, rules.durationMin) + partySize > rules.capacity) return false;
  }
  return true;
}

export interface DayCheck {
  ok: boolean;
  reason?: 'PASADO' | 'LEJOS' | 'DIA_CERRADO'; // solo cuando no se puede
}

// ¿Se puede reservar ese día? (que no haya pasado, que no sea demasiado lejos, y que el local atienda ese día)
export function checkDay(day: string, rules: ReservationRules, now: { day: string; min: number }): DayCheck {
  if (day < now.day) return { ok: false, reason: 'PASADO' };
  if (day > addDaysTo(now.day, rules.advanceDays)) return { ok: false, reason: 'LEJOS' };
  if (!rules.days.includes(weekdayOf(day))) return { ok: false, reason: 'DIA_CERRADO' };
  return { ok: true };
}

// ¿Ese horario todavía se puede reservar, por anticipación mínima? (solo importa el día de hoy)
export function enoughNotice(day: string, startMin: number, rules: ReservationRules, now: { day: string; min: number }): boolean {
  return day !== now.day || startMin >= now.min + rules.noticeMin;
}

export interface SlotView {
  time: string;
  available: boolean;
  // por qué no está disponible: sin lugar para esa cantidad de personas, o ya muy cerca
  reason?: 'LLENO' | 'ANTICIPACION';
}

export function availability(
  existing: Occupying[],
  day: string,
  partySize: number,
  rules: ReservationRules,
  now: { day: string; min: number },
): SlotView[] {
  return slotTimes(rules).map((m) => {
    if (!enoughNotice(day, m, rules, now)) return { time: minToTime(m), available: false, reason: 'ANTICIPACION' as const };
    if (!fits(existing, m, partySize, rules)) return { time: minToTime(m), available: false, reason: 'LLENO' as const };
    return { time: minToTime(m), available: true };
  });
}

// Teléfono: se guardan solo los dígitos (entre 8 y 15)
export function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// Los últimos dígitos alcanzan para comprobar que quien cancela es quien reservó
export const samePhone = (stored: string, given: unknown): boolean => {
  const g = String(given ?? '').replace(/\D/g, '');
  return g.length >= 6 && stored.length >= 6 && g.slice(-6) === stored.slice(-6);
};

// Código corto de la reserva (sin caracteres que se confunden)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newReservationCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(random() * CODE_CHARS.length)];
  return out;
}

// Texto de la URL pública de un negocio: minúsculas, sin tildes, con guiones
export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'restaurante';
}

// ¿Las reglas tienen sentido? Devuelve el mensaje del primer problema, o null.
export function validateRules(r: ReservationRules): string | null {
  if (![15, 30, 60].includes(r.slotMin)) return 'Los horarios pueden ser cada 15, 30 o 60 minutos';
  if (!(r.openMin >= 0 && r.closeMin < 24 * 60 && r.openMin <= r.closeMin)) return 'El horario de apertura tiene que ser anterior al último horario reservable';
  if (!(r.durationMin >= 30 && r.durationMin <= 300)) return 'Cada reserva ocupa la mesa entre 30 minutos y 5 horas';
  if (!(r.capacity >= 1 && r.capacity <= 1000)) return 'La capacidad tiene que estar entre 1 y 1000 personas';
  if (!(r.maxParty >= 1 && r.maxParty <= r.capacity)) return 'El máximo por reserva no puede superar la capacidad del local';
  if (!(r.advanceDays >= 1 && r.advanceDays <= 180)) return 'La anticipación máxima va de 1 a 180 días';
  if (!(r.noticeMin >= 0 && r.noticeMin <= 24 * 60)) return 'La anticipación mínima va de 0 a 24 horas';
  if (!r.days.length || r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Elegí al menos un día de la semana';
  return null;
}
