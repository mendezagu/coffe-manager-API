import { ConflictException, ForbiddenException } from '@nestjs/common';
import { assertWithinLimit, limitMessage, usageOf } from './limits';

// Una base de mentira: solo responde lo que el control de topes le pregunta
const fakeDb = (plan: string, counts: Partial<Record<'table' | 'menuItem' | 'user' | 'waiter' | 'sale' | 'deliveryOrder', number>>) =>
  ({
    tenant: { findUnique: async () => ({ plan, addons: [] }) },
    table: { count: async () => counts.table ?? 0 },
    menuItem: { count: async () => counts.menuItem ?? 0 },
    user: { count: async () => counts.user ?? 0 },
    waiter: { count: async () => counts.waiter ?? 0 },
    sale: { count: async () => counts.sale ?? 0 },
    deliveryOrder: { count: async () => counts.deliveryOrder ?? 0 },
  }) as any;

describe('Topes de los planes gratis', () => {
  it('deja agregar mientras no se llegó al tope y corta en el tope', async () => {
    await expect(assertWithinLimit(fakeDb('free', { table: 4 }), 't', 'tables')).resolves.toBeUndefined();
    await expect(assertWithinLimit(fakeDb('free', { table: 5 }), 't', 'tables')).rejects.toThrow(ForbiddenException);
  });

  it('el mensaje dice el plan, el tope y qué hacer', async () => {
    await expect(assertWithinLimit(fakeDb('free', { table: 5 }), 't', 'tables')).rejects.toThrow('Llegaste al límite de tu plan Gratis: hasta 5 mesas');
    await expect(assertWithinLimit(fakeDb('free', { sale: 20 }), 't', 'counterSalesPerMonth')).rejects.toThrow('hasta 20 ventas de mostrador por mes');
  });

  it('un tope en 0 significa que el plan no lo incluye', async () => {
    await expect(assertWithinLimit(fakeDb('free_takeaway', {}), 't', 'tables')).rejects.toThrow('no incluye mesas');
    expect(limitMessage('free_takeaway', 'tables', 0)).toContain('Gratis Takeaway');
  });

  it('los planes pagos no tienen topes', async () => {
    for (const plan of ['basic', 'takeaway', 'pro', 'benefits']) {
      await expect(assertWithinLimit(fakeDb(plan, { table: 500, menuItem: 9999, user: 99, sale: 99999 }), 't', 'tables')).resolves.toBeUndefined();
      await expect(assertWithinLimit(fakeDb(plan, { sale: 99999 }), 't', 'counterSalesPerMonth')).resolves.toBeUndefined();
    }
  });

  it('quien pide desde la tienda pública no se entera del plan del local', async () => {
    const db = fakeDb('free_takeaway', { deliveryOrder: 20 });
    await expect(assertWithinLimit(db, 't', 'onlineOrdersPerMonth', { publicFacing: true })).rejects.toThrow(ConflictException);
    await expect(assertWithinLimit(db, 't', 'onlineOrdersPerMonth', { publicFacing: true })).rejects.not.toThrow(/plan/i);
  });

  it('el uso informa cuánto lleva el negocio de cada tope', async () => {
    const usage = await usageOf(fakeDb('free', { table: 4, menuItem: 12, user: 1, sale: 7 }), 't');
    expect(usage.tables).toEqual({ used: 4, max: 5 });
    expect(usage.menuItems).toEqual({ used: 12, max: 30 });
    expect(usage.counterSalesPerMonth).toEqual({ used: 7, max: 20 });
    expect(usage.historyDays).toBe(30);
    expect(await usageOf(fakeDb('pro', {}), 't')).toEqual({});
  });
});

describe('Altas de a varias (onboarding)', () => {
  it('crear 5 mesas entra en el gratis, 6 no', async () => {
    await expect(assertWithinLimit(fakeDb('free', { table: 0 }), 't', 'tables', { adding: 5 })).resolves.toBeUndefined();
    await expect(assertWithinLimit(fakeDb('free', { table: 0 }), 't', 'tables', { adding: 6 })).rejects.toThrow(ForbiddenException);
    await expect(assertWithinLimit(fakeDb('free', { table: 3 }), 't', 'tables', { adding: 3 })).rejects.toThrow('hasta 5 mesas');
  });
});

describe('Tope de mozos', () => {
  it('el gratis permite 3 mozos y corta al cuarto', async () => {
    await expect(assertWithinLimit(fakeDb('free', { waiter: 2 }), 't', 'waiters')).resolves.toBeUndefined();
    await expect(assertWithinLimit(fakeDb('free', { waiter: 3 }), 't', 'waiters')).rejects.toThrow('hasta 3 mozos');
    await expect(assertWithinLimit(fakeDb('pro', { waiter: 50 }), 't', 'waiters')).resolves.toBeUndefined();
  });
});
