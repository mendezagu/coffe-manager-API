import { PrismaService } from '../prisma/prisma.service';
import { PlatformTenantsService } from './platform-tenants.service';

// Sin base de datos: Prisma se simula y se comprueba qué se pide y qué se devuelve.

const row = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Café Central',
  plan: 'pro',
  createdAt: new Date('2026-10-01T10:00:00Z'),
  legalName: 'Café Central SRL',
  taxIdLabel: 'CUIT',
  taxId: '30-12345678-9',
  address: 'Av. San Martín 123',
  city: 'Córdoba',
  postalCode: '5000',
  phone: '351 555-1234',
  ticketFooter: '¡Gracias por su visita!',
  currencyCode: 'ARS',
  locale: 'es-AR',
  logoUrl: null,
  users: [{ name: 'Lucía', email: 'lucia@cafe.com', active: true }],
  _count: { users: 4, hotelPartners: 2 },
  ...over,
});

describe('PlatformTenantsService.list', () => {
  const build = (rows: unknown[]) => {
    const findMany = jest.fn(async () => rows);
    const service = new PlatformTenantsService({ tenant: { findMany } } as unknown as PrismaService);
    return { service, findMany };
  };

  it('devuelve el id, el nombre, los datos de "Mi negocio" y el email del administrador', async () => {
    const { service } = build([row()]);
    const [t] = await service.list();
    expect(t.id).toBe('t1');
    expect(t.name).toBe('Café Central');
    expect(t.business).toMatchObject({ legalName: 'Café Central SRL', taxIdLabel: 'CUIT', taxId: '30-12345678-9', city: 'Córdoba', phone: '351 555-1234' });
    expect(t.admins).toEqual([{ name: 'Lucía', email: 'lucia@cafe.com', active: true }]);
    expect(t.users).toBe(4);
    expect(t.hotels).toBe(2);
  });

  it('pide solo los administradores y nunca contraseñas ni datos internos', async () => {
    const { service, findMany } = build([]);
    await service.list();
    const args = findMany.mock.calls[0] as unknown as [{ select: Record<string, any> }];
    const select = args[0].select;
    expect(select.users.where).toEqual({ role: 'ADMIN' });
    expect(select.users.select).toEqual({ name: true, email: true, active: true });
    expect(Object.keys(select)).not.toContain('qrPin');
    expect(JSON.stringify(select)).not.toContain('passwordHash');
  });

  it('no manda el logo (puede ser una imagen enorme): solo si lo cargó', async () => {
    const big = 'data:image/png;base64,' + 'A'.repeat(50_000);
    const { service } = build([row({ logoUrl: big }), row({ id: 't2', logoUrl: null })]);
    const list = await service.list();
    expect(list[0].business.hasLogo).toBe(true);
    expect(list[1].business.hasLogo).toBe(false);
    expect(JSON.stringify(list)).not.toContain('AAAA');
  });

  it('un restaurante sin administradores activos igual aparece', async () => {
    const { service } = build([row({ users: [] })]);
    const [t] = await service.list();
    expect(t.admins).toEqual([]);
  });
});
