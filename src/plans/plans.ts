// Funciones que se pueden habilitar o no según el plan del negocio.
// Para sumar una función: agregarla acá y a los planes que la incluyen; el resto del sistema pregunta siempre
// con `hasFeature`, nunca por el nombre del plan.
//
// Dos familias de planes:
//  - Con salón (mesas y mozos), de menor a mayor: basic = "Esencial", pro = "Pro", benefits = "Beneficios". Cada uno hereda del anterior.
//  - Takeaway ("Para llevar"): negocios que venden solo en mostrador (pizzerías, lomiterías, café al paso, heladerías). Sin mesas.
// Además, cada negocio puede tener "extras": funciones sueltas sumadas a su plan (ej: un restaurante Esencial con Mostrador).
//
// OJO: las funciones marcadas "informativa" todavía NO se bloquean en el servidor: hoy solo se muestra a qué plan
// pertenecen (etiquetas en la app). Se bloquean cuando se decida el plan de cada negocio existente.
export type Feature =
  | 'tables' // Salón: mesas, mozos y sectores (informativa: la app oculta lo que no aplica)
  | 'counter_sales' // Mostrador: venta sin mesa
  | 'kitchen_bar_split'
  | 'inventory'
  | 'qr_ordering'
  | 'modifiers' // informativa
  | 'advanced_reports' // informativa
  | 'commission' // informativa
  | 'reservations' // informativa
  | 'logs' // informativa: el historial vive en el navegador, así que solo lo bloquea la app
  | 'hotels'; // informativa

// Planes con salón, de menor a mayor (la escalera). Los precios se definen aparte.
export const PLAN_ORDER = ['basic', 'pro', 'benefits'] as const;
export type LadderPlan = (typeof PLAN_ORDER)[number];

// Todos los planes que se pueden asignar
export const PLAN_KEYS = ['takeaway', ...PLAN_ORDER] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const PLAN_LABELS: Record<PlanKey, string> = {
  takeaway: 'Takeaway',
  basic: 'Esencial',
  pro: 'Pro',
  benefits: 'Beneficios',
};

// Lo que suma cada plan de la escalera respecto del anterior
const PLAN_ADDS: Record<LadderPlan, Feature[]> = {
  basic: ['tables'],
  pro: ['counter_sales', 'kitchen_bar_split', 'inventory', 'qr_ordering', 'modifiers', 'advanced_reports', 'commission', 'reservations', 'logs'],
  benefits: ['hotels'],
};

// Takeaway: venta en mostrador, sin mesas, mozos, reservas ni pedido por QR de mesa
const TAKEAWAY_FEATURES: Feature[] = ['counter_sales', 'modifiers'];

export const PLAN_FEATURES: Record<string, Feature[]> = {
  takeaway: TAKEAWAY_FEATURES,
  ...Object.fromEntries(PLAN_ORDER.map((plan, i) => [plan, PLAN_ORDER.slice(0, i + 1).flatMap((p) => PLAN_ADDS[p])])),
};

export const FEATURE_LABELS: Record<Feature, string> = {
  tables: 'Salón: mesas, mozos y sectores',
  counter_sales: 'Mostrador (venta sin mesa)',
  kitchen_bar_split: 'Separar cocina y barra',
  inventory: 'Inventario y stock',
  qr_ordering: 'Pedido por QR en la mesa',
  modifiers: 'Modificadores y extras',
  advanced_reports: 'Reportes completos',
  commission: 'Comisión de mozos',
  reservations: 'Reservas de mesa',
  logs: 'Historial de acciones (Logs)',
  hotels: 'Hoteles aliados y vouchers',
};

// Funciones que se pueden sumar a un negocio como extra (los hoteles dependen de la plataforma, no se suman sueltos)
export const ADDON_FEATURES: Feature[] = (Object.keys(FEATURE_LABELS) as Feature[]).filter((f) => f !== 'hotels');

// Cómo vende el negocio: define qué partes se muestran en la app (no cambia lo que cobra)
export const SALES_MODES = ['both', 'counter', 'tables'] as const;
export type SalesMode = (typeof SALES_MODES)[number];

// Lo mínimo que hace falta de un negocio para saber qué funciones tiene: su plan y sus extras
export type PlanSubject = string | { plan: string; addons?: string[] | null };

export function featuresOf(subject: PlanSubject): Feature[] {
  const plan = typeof subject === 'string' ? subject : subject.plan;
  const addons = typeof subject === 'string' ? [] : (subject.addons ?? []);
  const base = PLAN_FEATURES[plan] ?? [];
  return [...new Set([...base, ...(addons.filter((a) => ADDON_FEATURES.includes(a as Feature)) as Feature[])])];
}

export function hasFeature(subject: PlanSubject, feature: Feature): boolean {
  return featuresOf(subject).includes(feature);
}

// Plan más bajo de la escalera que incluye cada función (para mostrar la etiqueta en la app)
export function featurePlans(): Record<Feature, LadderPlan> {
  const out = {} as Record<Feature, LadderPlan>;
  for (const plan of PLAN_ORDER) for (const f of PLAN_ADDS[plan]) out[f] = plan;
  return out;
}

// Mensaje para quien intenta usar algo que su plan no incluye
export function featureDeniedMessage(feature: Feature): string {
  const plan = featurePlans()[feature];
  return `Tu plan no incluye "${FEATURE_LABELS[feature]}". Está disponible desde el plan ${PLAN_LABELS[plan]}.`;
}
