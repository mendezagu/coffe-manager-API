// Fechas "de calendario" en la zona horaria del negocio. Los reportes agrupan por día, y el
// día de una venta depende de la zona (una venta a las 23:30 en Buenos Aires ya es "mañana" en UTC).

// Zona válida según Intl (ej: America/Argentina/Buenos_Aires)
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Diferencia (en ms) entre la hora local de la zona y UTC en ese instante
function offsetMs(date: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return localAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Instante (UTC) en que empieza el día `YYYY-MM-DD` en esa zona
export function startOfDay(day: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const wallClock = Date.UTC(y, m - 1, d);
  // Dos pasadas: la segunda corrige el caso en que el offset cambia ese día (horario de verano)
  let t = wallClock - offsetMs(new Date(wallClock), tz);
  t = wallClock - offsetMs(new Date(t), tz);
  return new Date(t);
}

// Día local (`YYYY-MM-DD`) de un instante en esa zona
export function localDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Cantidad de días entre dos fechas (a <= b), contando ambos extremos
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000) + 1;
}
