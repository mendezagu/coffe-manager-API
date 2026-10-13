// Funciones que se pueden habilitar o no según el plan del negocio.
// Para sumar una función: agregarla acá y a los planes que la incluyen; el resto del sistema
// pregunta siempre con `hasFeature`, nunca por el nombre del plan.
export type Feature = 'kitchen_bar_split' | 'inventory' | 'qr_ordering';

export const PLAN_FEATURES: Record<string, Feature[]> = {
  basic: [],
  pro: ['kitchen_bar_split', 'inventory', 'qr_ordering'],
};

export const FEATURE_LABELS: Record<Feature, string> = {
  kitchen_bar_split: 'Separar cocina y barra',
  inventory: 'Inventario y stock',
  qr_ordering: 'Pedido por QR en la mesa',
};

export function featuresOf(plan: string): Feature[] {
  return PLAN_FEATURES[plan] ?? [];
}

export function hasFeature(plan: string, feature: Feature): boolean {
  return featuresOf(plan).includes(feature);
}
