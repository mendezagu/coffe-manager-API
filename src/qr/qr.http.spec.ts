import { CanActivate, ExecutionContext, INestApplication, Injectable, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { QrModule } from './qr.module';

// Reemplaza al JwtAuthGuard real (usa @nestjs/jwt, un módulo ESM que Jest no carga): mismas reglas de
// ruta pública y de usuario leído de la base, pero la "sesión" es el id del usuario en un encabezado.
// El RolesGuard sí es el real.
@Injectable()
class TestAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest();
    const id = request.headers['x-test-user'];
    const user = id ? await this.prisma.user.findUnique({ where: { id: String(id) } }) : null;
    if (!user || !user.active) throw new UnauthorizedException('Falta la sesión');
    request.user = { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId };
    return true;
  }
}

// Prueba la API completa por HTTP (guards, validación y rutas públicas), contra la base de pruebas.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}
process.env.DATABASE_URL = TEST_DATABASE_URL;

describe('Pedido por QR · API por HTTP', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  let tenantId: string;
  let token: string;
  let dish: { id: string };
  const tokens: Record<string, string> = {};

  const call = async (method: string, path: string, opts: { body?: unknown; auth?: string; ip?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.auth ? { 'x-test-user': opts.auth } : {}),
        'x-forwarded-for': opts.ip ?? '203.0.113.1',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, QrModule],
      providers: [
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    const tenant = await prisma.tenant.create({ data: { name: 'Bar HTTP', plan: 'pro', qrEnabled: true } });
    tenantId = tenant.id;
    token = 'http-token-mesa-1-aaaaaaaaaaaa';
    await prisma.table.create({ data: { tenantId, name: 'Mesa 1', qrToken: token } });
    dish = await prisma.menuItem.create({ data: { tenantId, name: 'Café', price: 1000 } });

    for (const role of [Role.ADMIN, Role.WAITER, Role.KITCHEN]) {
      const user = await prisma.user.create({
        data: { tenantId, email: `${role}@http.test`, name: role, passwordHash: 'x', role },
      });
      tokens[role] = user.id;
    }
  });

  const order = (items: unknown, extra: Record<string, unknown> = {}) => ({
    clientId: 'cliente-http-1234',
    items,
    ...extra,
  });

  it('la carta se abre sin iniciar sesión', async () => {
    const res = await call('GET', `/api/public/mesa/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.menu.items.map((i: any) => i.name)).toEqual(['Café']);
  });

  it('un código inexistente responde 404', async () => {
    const res = await call('GET', '/api/public/mesa/codigo-que-no-existe-xxxxxxxx');
    expect(res.status).toBe(404);
  });

  it('enviar un pedido válido sin sesión funciona', async () => {
    const res = await call('POST', `/api/public/mesa/${token}/orders`, {
      body: order([{ menuItemId: dish.id, quantity: 2 }]),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ step: 'RECEIVED', total: 2000 });
  });

  it('un precio mandado por el cliente se ignora', async () => {
    const res = await call('POST', `/api/public/mesa/${token}/orders`, {
      body: order([{ menuItemId: dish.id, quantity: 1, price: 1, unitPrice: 1 }], { total: 1 }),
      ip: '203.0.113.2',
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1000);
  });

  it.each([
    ['sin platos', (dishId: string) => order([])],
    ['cantidad cero', (dishId: string) => order([{ menuItemId: dishId, quantity: 0 }])],
    ['cantidad negativa', (dishId: string) => order([{ menuItemId: dishId, quantity: -3 }])],
    ['cantidad decimal', (dishId: string) => order([{ menuItemId: dishId, quantity: 1.5 }])],
    ['cantidad enorme', (dishId: string) => order([{ menuItemId: dishId, quantity: 9999 }])],
    ['id con caracteres raros', (dishId: string) => order([{ menuItemId: "x'; DROP TABLE orders;--", quantity: 1 }])],
    ['nota demasiado larga', (dishId: string) => order([{ menuItemId: dishId, quantity: 1, note: 'a'.repeat(500) }])],
    ['nombre demasiado largo', (dishId: string) => order([{ menuItemId: dishId, quantity: 1 }], { customerName: 'a'.repeat(200) })],
    ['sin identificador de celular', (dishId: string) => ({ items: [{ menuItemId: dishId, quantity: 1 }] })],
    ['items que no es una lista', (dishId: string) => order('hola')],
  ])('rechaza un pedido mal formado: %s', async (_name, makeBody) => {
    const body = makeBody(dish.id);
    const res = await call('POST', `/api/public/mesa/${token}/orders`, { body, ip: `203.0.113.${50 + Math.floor(Math.random() * 100)}` });
    expect(res.status).toBe(400);
    expect(await prisma.qrOrderRequest.count({})).toBe(0);
  });

  it('la bandeja y los códigos del personal exigen sesión', async () => {
    for (const [method, path] of [
      ['GET', '/api/qr/inbox'],
      ['GET', '/api/qr/tables'],
      ['POST', '/api/qr/tables/generate'],
      ['POST', '/api/qr/requests/x/confirm'],
    ]) {
      expect((await call(method, path)).status).toBe(401);
    }
  });

  it('cocina no atiende pedidos por QR', async () => {
    expect((await call('GET', '/api/qr/inbox', { auth: tokens.KITCHEN })).status).toBe(403);
  });

  it('el mozo atiende pedidos, pero no maneja los códigos ni ve los secretos', async () => {
    expect((await call('GET', '/api/qr/inbox', { auth: tokens.WAITER })).status).toBe(200);
    expect((await call('POST', '/api/qr/tables/generate', { auth: tokens.WAITER })).status).toBe(403);

    const asWaiter = await call('GET', '/api/qr/tables', { auth: tokens.WAITER });
    expect(asWaiter.status).toBe(200);
    expect(JSON.stringify(asWaiter.body)).not.toContain(token);

    const asAdmin = await call('GET', '/api/qr/tables', { auth: tokens.ADMIN });
    expect(asAdmin.body.tables[0].token).toBe(token);
  });

  it('flujo completo: el cliente pide, el mozo confirma y el cliente lo ve confirmado', async () => {
    const sent = await call('POST', `/api/public/mesa/${token}/orders`, {
      body: order([{ menuItemId: dish.id, quantity: 1 }]),
      ip: '203.0.113.7',
    });
    const inbox = await call('GET', '/api/qr/inbox', { auth: tokens.WAITER });
    expect(inbox.body.requests).toHaveLength(1);
    expect(inbox.body.requests[0]).toMatchObject({ tableName: 'Mesa 1', hasWaiter: false, tableFree: true });

    const confirmed = await call('POST', `/api/qr/requests/${sent.body.id}/confirm`, { auth: tokens.WAITER, body: {} });
    expect(confirmed.status).toBe(201);

    const mine = await call('POST', `/api/public/mesa/${token}/my-orders`, {
      body: { clientId: 'cliente-http-1234' },
      ip: '203.0.113.8',
    });
    expect(mine.body.requests[0].step).toBe('CONFIRMED');
    expect(await prisma.order.count({})).toBe(1);
  });
});
