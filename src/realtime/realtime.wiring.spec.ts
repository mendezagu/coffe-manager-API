// La librería de login es ESM y Jest (CommonJS) no la carga; acá el login se simula igual.
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { CanActivate, Controller, ExecutionContext, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { RealtimeAdapter } from './realtime.adapter';
import { RealtimeAuth, SocketAuth } from './realtime.auth';
import { RealtimeModule } from './realtime.module';
import { tenantRoom } from './realtime.topics';

// Prueba el módulo REAL de tiempo real conectado a una app: con el interceptor global y un servidor de sockets de verdad.
// Un controlador de ejemplo hace de "mesas" y una guarda hace de login (deja pasar y pone el negocio del usuario).

@Controller('api/tables')
class FakeTablesController {
  @Get() list() {
    return [];
  }
  @Post(':id/orders') add() {
    return { ok: true };
  }
}

@Controller('api/menu')
class FakeMenuController {
  @Post() create() {
    return { ok: true };
  }
}

class FakeLoginGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'u1', tenantId: req.headers['x-tenant'] ?? 'A' };
    return true;
  }
}

describe('Tiempo real: conectado a la app', () => {
  let app: INestApplication;
  let base: string;
  const clients: Socket[] = [];

  const fakeAuth = {
    authenticate: async (auth?: SocketAuth) => (typeof auth?.token === 'string' ? { rooms: [tenantRoom(auth.token)] } : null),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeModule],
      controllers: [FakeTablesController, FakeMenuController],
      providers: [{ provide: APP_GUARD, useClass: FakeLoginGuard }],
    })
      .overrideProvider(RealtimeAuth)
      .useValue(fakeAuth)
      .compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new RealtimeAdapter(app));
    await app.listen(0);
    base = `http://localhost:${app.getHttpServer().address().port}`;
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  const listen = (tenant: string) =>
    new Promise<any[]>((resolve) => {
      const received: any[] = [];
      const socket = io(`${base}/realtime`, { auth: { token: tenant }, transports: ['websocket'], reconnection: false, forceNew: true });
      clients.push(socket);
      socket.on('changed', (m) => received.push(m));
      socket.on('connect', () => setTimeout(() => resolve(received), 80));
    });
  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  it('al cargar platos en una mesa, las pantallas del negocio se enteran solas (mesas y cocina)', async () => {
    const mine = await listen('A');
    const other = await listen('B');
    const res = await fetch(`${base}/api/tables/1/orders`, { method: 'POST', headers: { 'x-tenant': 'A' } });
    expect(res.status).toBe(201);
    await wait();
    expect(mine).toEqual([{ topic: 'tables' }, { topic: 'kitchen' }]);
    expect(other).toEqual([]);
  });

  it('las consultas y las modificaciones de cosas que no son en vivo no avisan nada', async () => {
    const mine = await listen('A');
    await fetch(`${base}/api/tables`, { headers: { 'x-tenant': 'A' } });
    await fetch(`${base}/api/menu`, { method: 'POST', headers: { 'x-tenant': 'A' } });
    await wait();
    expect(mine).toEqual([]);
  });
});
