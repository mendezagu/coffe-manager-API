import { PLAN_FEATURES, featurePlans, featuresOf, hasFeature } from './plans';

describe('Planes', () => {
  it('cada plan hereda lo del anterior', () => {
    expect(featuresOf('basic')).toEqual([]);
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

  it('un plan desconocido no incluye nada y los tres planes existen', () => {
    expect(featuresOf('otro')).toEqual([]);
    expect(Object.keys(PLAN_FEATURES)).toEqual(['basic', 'pro', 'benefits']);
  });
});
