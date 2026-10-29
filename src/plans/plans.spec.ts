import { ADDON_FEATURES, PLAN_FEATURES, featurePlans, featuresOf, hasFeature } from './plans';

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
    expect(Object.keys(PLAN_FEATURES)).toEqual(['takeaway', 'basic', 'pro', 'benefits']);
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
});
