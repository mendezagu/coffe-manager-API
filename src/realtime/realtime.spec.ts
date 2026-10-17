// La librería de login es ESM y Jest (CommonJS) no la carga; acá el login se simula igual.
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { lastValueFrom, of, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeAuth } from './realtime.auth';
import { RealtimeInterceptor } from './realtime.interceptor';
import { Broadcaster, RealtimeService } from './realtime.service';
import { affectsCustomers, customersRoom, tenantRoom, topicsForPath } from './realtime.topics';

// Estas pruebas no necesitan base de datos ni un servidor de sockets: todo se simula.

describe('Tiempo real: qué se avisa y a quién', () => {
  describe('topicsForPath', () => {
    it('una modificación de mesas refresca mesas y cocina', () => {
      expect(topicsForPath('/api/tables/abc/orders')).toEqual(['tables', 'kitchen']);
    });

    it('un pedido por QR refresca QR, mesas y cocina', () => {
      expect(topicsForPath('/api/qr/requests/1/confirm')).toEqual(['qr', 'tables', 'kitchen']);
    });

    it('la cocina refresca cocina y mesas; cobrar refresca mesas y cocina', () => {
      expect(topicsForPath('/api/kitchen/orders/1/status')).toEqual(['kitchen', 'tables']);
      expect(topicsForPath('/api/sales/checkout')).toEqual(['tables', 'kitchen']);
    });

    it('ignora el query string y lo que no depende del tiempo real', () => {
      expect(topicsForPath('/api/tables?x=1')).toEqual(['tables', 'kitchen']);
      expect(topicsForPath('/api/menu/1')).toEqual([]);
      expect(topicsForPath('/api/settings')).toEqual([]);
      expect(topicsForPath('/otra/cosa')).toEqual([]);
      expect(topicsForPath('')).toEqual([]);
    });

    it('los clientes del QR solo reciben avisos de pedidos y cocina', () => {
      expect(affectsCustomers(['qr'])).toBe(true);
      expect(affectsCustomers(['tables', 'kitchen'])).toBe(true);
      expect(affectsCustomers(['tables'])).toBe(false);
    });
  });

  describe('RealtimeService', () => {
    const makeServer = () => {
      const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
      const server: Broadcaster = {
        to: (room: string) => ({ emit: (event: string, payload: unknown) => void emitted.push({ room, event, payload }) }),
      };
      return { server, emitted };
    };

    it('avisa solo a la sala del negocio (nunca a otro)', () => {
      const { server, emitted } = makeServer();
      const service = new RealtimeService();
      service.setServer(server);
      service.notifyTenant('t1', ['tables']);
      expect(emitted).toEqual([{ room: tenantRoom('t1'), event: 'changed', payload: { topic: 'tables' } }]);
    });

    it('avisa también a los clientes cuando cambian los pedidos o la cocina', () => {
      const { server, emitted } = makeServer();
      const service = new RealtimeService();
      service.setServer(server);
      service.notifyTenant('t1', ['qr']);
      expect(emitted).toContainEqual({ room: customersRoom('t1'), event: 'changed', payload: { topic: 'orders' } });
    });

    it('no hace nada sin servidor, sin negocio o sin temas, y nunca lanza error', () => {
      const service = new RealtimeService();
      expect(() => service.notifyTenant('t1', ['tables'])).not.toThrow();
      const { server, emitted } = makeServer();
      service.setServer(server);
      service.notifyTenant('', ['tables']);
      service.notifyTenant('t1', []);
      expect(emitted).toHaveLength(0);
      service.setServer({
        to: () => {
          throw new Error('socket caído');
        },
      });
      expect(() => service.notifyTenant('t1', ['tables'])).not.toThrow();
    });
  });

  describe('RealtimeAuth', () => {
    const FUTURE = Math.floor(Date.now() / 1000) + 3600;
    const build = (opts: { payload?: any; user?: any; table?: any } = {}) => {
      const jwt = {
        verifyAsync: jest.fn(async (token: string) => {
          if (token !== 'valido') throw new Error('jwt malformed');
          return opts.payload ?? { sub: 'u1', exp: FUTURE };
        }),
      } as unknown as JwtService;
      const prisma = {
        user: { findUnique: jest.fn(async () => opts.user ?? null) },
        table: { findUnique: jest.fn(async () => opts.table ?? null) },
      } as unknown as PrismaService;
      return new RealtimeAuth(jwt, prisma);
    };

    it('el personal entra a la sala de SU negocio', async () => {
      const access = await build({ user: { id: 'u1', active: true, tenantId: 't9' } }).authenticate({ token: 'valido' });
      expect(access?.rooms).toEqual([tenantRoom('t9')]);
      expect(access?.expiresInMs).toBeGreaterThan(0);
    });

    it('rechaza un token inválido, un usuario inactivo o inexistente', async () => {
      expect(await build().authenticate({ token: 'falso' })).toBeNull();
      expect(await build({ user: { id: 'u1', active: false, tenantId: 't9' } }).authenticate({ token: 'valido' })).toBeNull();
      expect(await build({ user: null }).authenticate({ token: 'valido' })).toBeNull();
    });

    it('un cliente con el código de su mesa entra a la sala de clientes de ese negocio', async () => {
      const table = { tenantId: 't9', tenant: { qrEnabled: true, plan: 'pro' } };
      const access = await build({ table }).authenticate({ qrToken: 'a'.repeat(24) });
      expect(access?.rooms).toEqual([customersRoom('t9')]);
    });

    it('rechaza códigos de mesa inexistentes, con formato raro o de un negocio con el QR apagado', async () => {
      expect(await build({ table: null }).authenticate({ qrToken: 'a'.repeat(24) })).toBeNull();
      expect(await build().authenticate({ qrToken: 'corto' })).toBeNull();
      expect(await build().authenticate({ qrToken: '../../etc/passwd-aaaaaaaa' })).toBeNull();
      const off = { tenantId: 't9', tenant: { qrEnabled: false, plan: 'pro' } };
      expect(await build({ table: off }).authenticate({ qrToken: 'a'.repeat(24) })).toBeNull();
      const basic = { tenantId: 't9', tenant: { qrEnabled: true, plan: 'basic' } };
      expect(await build({ table: basic }).authenticate({ qrToken: 'a'.repeat(24) })).toBeNull();
    });

    it('sin credenciales, o con credenciales que no son texto, no entra nadie', async () => {
      const auth = build();
      expect(await auth.authenticate(undefined)).toBeNull();
      expect(await auth.authenticate({})).toBeNull();
      expect(await auth.authenticate({ token: 123, qrToken: { a: 1 } })).toBeNull();
    });
  });

  describe('RealtimeInterceptor', () => {
    const contextOf = (req: any, type = 'http') =>
      ({ getType: () => type, switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;
    const handler = (result: any = of('ok')) => ({ handle: () => result });

    it('avisa al negocio cuando una modificación sale bien', async () => {
      const notify = jest.fn();
      const interceptor = new RealtimeInterceptor({ notifyTenant: notify } as unknown as RealtimeService);
      const req = { method: 'POST', originalUrl: '/api/tables/1/orders', user: { tenantId: 't1' } };
      await lastValueFrom(interceptor.intercept(contextOf(req), handler()));
      expect(notify).toHaveBeenCalledWith('t1', ['tables', 'kitchen']);
    });

    it('no avisa en consultas (GET), sin sesión, ni en rutas que no son en vivo', async () => {
      const notify = jest.fn();
      const interceptor = new RealtimeInterceptor({ notifyTenant: notify } as unknown as RealtimeService);
      await lastValueFrom(interceptor.intercept(contextOf({ method: 'GET', originalUrl: '/api/tables', user: { tenantId: 't1' } }), handler()));
      await lastValueFrom(interceptor.intercept(contextOf({ method: 'POST', originalUrl: '/api/tables', user: undefined }), handler()));
      await lastValueFrom(interceptor.intercept(contextOf({ method: 'PUT', originalUrl: '/api/menu/1', user: { tenantId: 't1' } }), handler()));
      expect(notify).not.toHaveBeenCalled();
    });

    it('no avisa si la operación falló', async () => {
      const notify = jest.fn();
      const interceptor = new RealtimeInterceptor({ notifyTenant: notify } as unknown as RealtimeService);
      const req = { method: 'DELETE', originalUrl: '/api/tables/1', user: { tenantId: 't1' } };
      await expect(lastValueFrom(interceptor.intercept(contextOf(req), handler(throwError(() => new Error('falló')))))).rejects.toThrow('falló');
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
