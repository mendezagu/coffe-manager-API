// Funciones que se pueden habilitar o no según el plan del negocio.
// Para sumar una función: agregarla acá y al plan más bajo que la incluye (los planes de arriba la heredan);
// el resto del sistema pregunta siempre con `hasFeature`, nunca por el nombre del plan.
//
// Planes (de menor a mayor): basic = "Esencial", pro = "Pro", benefits = "Beneficios".
// OJO: las funciones marcadas "informativa" todavía NO se bloquean en el servidor: hoy solo se muestra a qué plan
// pertenecen (etiquetas en la app). Se bloquean cuando se decida el plan de cada negocio existente.
export type Feature =
  | 'kitchen_bar_split'
  | 'inventory'
  | 'qr_ordering'
  | 'modifiers' // informativa
  | 'advanced_reports' // informativa
  | 'commission' // informativa
  | 'reservations' // informativa
  | 'logs' // informativa: el historial vive en el navegador, así que solo lo bloquea la app
  | 'hotels'; // informativa

export const PLAN_ORDER = ['basic', 'pro', 'benefits'] as const;
export type PlanKey = (typeof PLAN_ORDER)[number];

export const PLAN_LABELS: Record<PlanKey, string> = {
  basic: 'Esencial',
  pro: 'Pro',
  benefits: 'Beneficios',
};

// Lo que suma cada plan respecto del anterior
const PLAN_ADDS: Record<PlanKey, Feature[]> = {
  basic: [],
  pro: ['kitchen_bar_split', 'inventory', 'qr_ordering', 'modifiers', 'advanced_reports', 'commission', 'reservations', 'logs'],
  benefits: ['hotels'],
};

export const PLAN_FEATURES: Record<string, Feature[]> = Object.fromEntries(
  PLAN_ORDER.map((plan, i) => [plan, PLAN_ORDER.slice(0, i + 1).flatMap((p) => PLAN_ADDS[p])]),
);

export const FEATURE_LABELS: Record<Feature, string> = {
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

export function featuresOf(plan: string): Feature[] {
  return PLAN_FEATURES[plan] ?? [];
}

export function hasFeature(plan: string, feature: Feature): boolean {
  return featuresOf(plan).includes(feature);
}

// Plan más bajo que incluye cada función (para mostrar la etiqueta en la app)
export function featurePlans(): Record<Feature, PlanKey> {
  const out = {} as Record<Feature, PlanKey>;
  for (const plan of PLAN_ORDER) for (const f of PLAN_ADDS[plan]) out[f] = plan;
  return out;
}

// Mensaje para quien intenta usar algo que su plan no incluye
export function featureDeniedMessage(feature: Feature): string {
  const plan = featurePlans()[feature];
  return `Tu plan no incluye "${FEATURE_LABELS[feature]}". Está disponible desde el plan ${PLAN_LABELS[plan]}.`;
}
