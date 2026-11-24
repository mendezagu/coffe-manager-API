import { ADDON_FEATURES, PLAN_FEATURES, featurePlans, featuresOf, hasFeature, isFreePlan, limitsOf } from './plans';

describe('Planes', () => {
  it('cada plan hereda lo del anterior', () => {
    expect(featuresOf('basic')).toEqual(['tables']);
    for (const f of featuresOf('basic')) expect(featuresOf('pro')).toContain(f);
    for (const f of featuresOf('pro')) expect(featuresOf('benefits')).toContain(f);
  });

  it('lo que ya se bloqueaba sigue en Pro (y no en Esencial)', () => {
    for (const f of ['kitchen_bar_split', 'inventory', 'qr_ordering'] as const) {
      expect(hasFeature('basic', f)).toBe(false);
      expect(hasFeature('pro', f)).toBe(true);
    }
  });

  it('hoteles es de Beneficios', () => {
    expect(hasFeature('pro', 'hotels')).toBe(false);
    expect(hasFeature('benefits', 'hotels')).toBe(true);
    expect(featurePlans().hotels).toBe('benefits');
    expect(featurePlans().reservations).toBe('pro');
  });

  it('un plan desconocido no incluye nada y los cuatro planes existen', () => {
    expect(featuresOf('otro')).toEqual([]);
    expect(Object.keys(PLAN_FEATURES)).toEqual(['free', 'free_takeaway', 'takeaway', 'basic', 'pro', 'benefits']);
  });

  it('el Mostrador viene incluido desde Pro (y en Takeaway), no en Esencial', () => {
    expect(hasFeature('basic', 'counter_sales')).toBe(false);
    expect(hasFeature('pro', 'counter_sales')).toBe(true);
    expect(hasFeature('benefits', 'counter_sales')).toBe(true);
    expect(hasFeature('takeaway', 'counter_sales')).toBe(true);
    expect(featurePlans().counter_sales).toBe('pro');
  });

  it('Takeaway no tiene salón: ni mesas, ni reservas, ni pedido por QR de mesa, ni hoteles', () => {
    for (const f of ['tables', 'reservations', 'qr_ordering', 'commission', 'hotels'] as const) expect(hasFeature('takeaway', f)).toBe(false);
  });

  it('los extras suman funciones al plan sin quitar las del plan', () => {
    const esencialConMostrador = { plan: 'basic', addons: ['counter_sales'] };
    expect(hasFeature(esencialConMostrador, 'counter_sales')).toBe(true);
    expect(hasFeature(esencialConMostrador, 'tables')).toBe(true);
    expect(hasFeature(esencialConMostrador, 'inventory')).toBe(false);
    // un extra que no existe, o los hoteles (no se suman sueltos), se ignoran
    expect(featuresOf({ plan: 'basic', addons: ['inventada', 'hotels'] })).toEqual(['tables']);
    expect(ADDON_FEATURES).not.toContain('hotels');
    // restaurante que además hace takeaway no se repite nada
    expect(featuresOf({ plan: 'pro', addons: ['counter_sales'] }).filter((f) => f === 'counter_sales')).toHaveLength(1);
  });

  it('los planes gratis tienen topes y los pagos no', () => {
    expect(limitsOf('free').tables).toBe(5);
    expect(limitsOf('free_takeaway').tables).toBe(0);
    expect(limitsOf('free_takeaway').onlineOrdersPerMonth).toBe(20);
    for (const plan of ['basic', 'takeaway', 'pro', 'benefits']) expect(limitsOf(plan)).toEqual({});
    expect(isFreePlan('free')).toBe(true);
    expect(isFreePlan({ plan: 'pro', addons: [] })).toBe(false);
  });

  it('el gratis con salón no incluye lo de Pro: inventario, reportes, reservas ni tienda online', () => {
    for (const f of ['inventory', 'advanced_reports', 'reservations', 'online_store', 'kitchen_bar_split', 'commission', 'hotels'] as const) {
      expect(hasFeature('free', f)).toBe(false);
    }
    expect(hasFeature('free', 'tables')).toBe(true);
    expect(hasFeature('free', 'qr_ordering')).toBe(true);
  });

  it('el gratis Takeaway no tiene salón pero sí tienda online', () => {
    expect(hasFeature('free_takeaway', 'tables')).toBe(false);
    expect(hasFeature('free_takeaway', 'qr_ordering')).toBe(false);
    expect(hasFeature('free_takeaway', 'online_store')).toBe(true);
  });
});
