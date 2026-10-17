// La librería de login es ESM y Jest (CommonJS) no la carga; acá el login se simula igual.
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, Socket } from 'socket.io-client';
import { RealtimeAdapter } from './realtime.adapter';
import { RealtimeAuth, SocketAuth } from './realtime.auth';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { customersRoom, tenantRoom } from './realtime.topics';

// Levanta un servidor de sockets de verdad (en un puerto libre) y conecta clientes reales.
// El login se simula: "staff-A" es personal del negocio A, "staff-B" del B y "mesa-A" un cliente del A.
describe('Tiempo real: conexiones reales', () => {
  let app: INestApplication;
  let url: string;
  let realtime: RealtimeService;
  const clients: Socket[] = [];

  const fakeAuth = {
    authenticate: async (auth?: SocketAuth) => {
      if (auth?.token === 'staff-A') return { rooms: [tenantRoom('A')] };
      if (auth?.token === 'staff-B') return { rooms: [tenantRoom('B')] };
      if (auth?.qrToken === 'mesa-A') return { rooms: [customersRoom('A')] };
      return null;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [RealtimeGateway, RealtimeService, { provide: RealtimeAuth, useValue: fakeAuth }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new RealtimeAdapter(app, ['http://localhost:4200']));
    await app.listen(0);
    realtime = app.get(RealtimeService);
    const address = app.getHttpServer().address();
    url = `http://localhost:${address.port}/realtime`;
  });

  afterEach(() => {
    while (clients.length) clients.pop()!.disconnect();
  });

  afterAll(async () => {
    await app.close();
  });

  // Conecta y devuelve el socket junto con todo lo que reciba
  const connect = (auth: SocketAuth) =>
    new Promise<{ socket: Socket; received: any[] }>((resolve, reject) => {
      const socket = io(url, { auth, transports: ['websocket'], reconnection: false, forceNew: true });
      clients.push(socket);
      const received: any[] = [];
      socket.on('changed', (payload) => received.push(payload));
      socket.on('connect', () => setTimeout(() => resolve({ socket, received }), 80)); // deja tiempo a que el servidor lo ubique en su sala
      socket.on('connect_error', reject);
    });

  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it('el personal recibe los avisos de su negocio y no los de otro', async () => {
    const a = await connect({ token: 'staff-A' });
    const b = await connect({ token: 'staff-B' });
    realtime.notifyTenant('A', ['tables']);
    await wait();
    expect(a.received).toEqual([{ topic: 'tables' }]);
    expect(b.received).toEqual([]);
  });

  it('los clientes del QR reciben solo avisos de pedidos de su negocio', async () => {
    const customer = await connect({ qrToken: 'mesa-A' });
    realtime.notifyTenant('A', ['tables']); // no afecta a clientes
    realtime.notifyTenant('B', ['qr']); // de otro negocio
    realtime.notifyTenant('A', ['qr']);
    await wait();
    expect(customer.received).toEqual([{ topic: 'orders' }]);
  });

  it('sin credenciales válidas la conexión se corta y no recibe nada', async () => {
    const intruder = await connect({ token: 'inventado' }).catch(() => null);
    realtime.notifyTenant('A', ['tables']);
    await wait();
    if (intruder) {
      expect(intruder.received).toEqual([]);
      expect(intruder.socket.connected).toBe(false);
    }
  });

  it('un origen que no está permitido no puede conectarse desde el navegador', async () => {
    const res = await fetch(`${url.replace('/realtime', '')}/socket.io/?EIO=4&transport=polling`, {
      headers: { Origin: 'https://sitio-malicioso.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://sitio-malicioso.com');
    const ok = await fetch(`${url.replace('/realtime', '')}/socket.io/?EIO=4&transport=polling`, { headers: { Origin: 'http://localhost:4200' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:4200');
  });
});
