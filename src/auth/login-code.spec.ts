import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { LOGIN_CODE_RE, freeLoginCode } from './login-code';

// @nestjs/jwt viene como módulo ESM y Jest no lo carga: se reemplaza por un firmador de mentira
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));

// Corre contra la base de pruebas (coffee_manager_test), nunca contra la de desarrollo.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Ingreso con código del local', () => {
  let prisma: PrismaService;
  let auth: AuthService;
  let users: UsersService;
  let settings: SettingsService;
  let a: string; // negocio A
  let b: string; // negocio B

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    const jwt = { signAsync: async (payload: object) => JSON.stringify(payload) } as unknown as JwtService;
    auth = new AuthService(prisma, jwt);
    users = new UsersService(prisma, { get: () => undefined } as any);
    settings = new SettingsService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    a = (await prisma.tenant.create({ data: { name: 'Nuovo Caffe', loginCode: 'nuovo-caffe' } })).id;
    b = (await prisma.tenant.create({ data: { name: 'La Pizzería', loginCode: 'la-pizzeria' } })).id;
  });

  const user = async (tenantId: string, email: string, password: string, extra: object = {}) =>
    prisma.user.create({ data: { tenantId, email, name: email, role: Role.WAITER, passwordHash: await bcrypt.hash(password, 4), ...extra } });

  describe('el mismo usuario en dos locales', () => {
    it('cada local puede tener su propio "mozo", y cada uno entra a su local', async () => {
      const ua = await user(a, 'mozo', 'clave-del-local-a');
      const ub = await user(b, 'mozo', 'clave-del-local-b');

      expect((await auth.login('mozo', 'clave-del-local-a', 'nuovo-caffe')).user.id).toBe(ua.id);
      expect((await auth.login('mozo', 'clave-del-local-b', 'la-pizzeria')).user.id).toBe(ub.id);
    });

    it('con el código de otro local no entra aunque la clave sea la correcta', async () => {
      await user(a, 'mozo', 'clave-del-local-a');

      await expect(auth.login('mozo', 'clave-del-local-a', 'la-pizzeria')).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('sin código, una clave que corresponde a una sola cuenta entra igual (versiones anteriores de la app)', async () => {
      const ua = await user(a, 'mozo', 'clave-del-local-a');
      await user(b, 'mozo', 'clave-del-local-b');

      expect((await auth.login('mozo', 'clave-del-local-a')).user.id).toBe(ua.id);
    });

    it('sin código, si la misma clave sirve en dos cuentas pide el código del local', async () => {
      await user(a, 'mozo', 'clave-repetida-1');
      await user(b, 'mozo', 'clave-repetida-1');

      await expect(auth.login('mozo', 'clave-repetida-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('un usuario inactivo, uno inexistente y un código inexistente dan el mismo mensaje', async () => {
      await user(a, 'mozo', 'clave-del-local-a', { active: false });
      const messages = await Promise.all([
        auth.login('mozo', 'clave-del-local-a', 'nuovo-caffe').catch((e) => e.message),
        auth.login('nadie', 'clave-del-local-a', 'nuovo-caffe').catch((e) => e.message),
        auth.login('mozo', 'clave-del-local-a', 'no-existe').catch((e) => e.message),
      ]);

      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('Usuario o contraseña incorrectos');
    });

    it('el código y el usuario se aceptan sin importar mayúsculas ni espacios', async () => {
      const ua = await user(a, 'mozo', 'clave-del-local-a');

      expect((await auth.login('  MOZO ', 'clave-del-local-a', ' Nuovo-Caffe ')).user.id).toBe(ua.id);
    });
  });

  describe('crear usuarios', () => {
    it('el mismo nombre en dos locales está permitido, y repetido dentro del local no', async () => {
      await users.create(a, { email: 'Cajero', password: 'clave-larga-1', name: 'Cajera A', role: Role.CASHIER });
      await expect(users.create(b, { email: 'cajero', password: 'clave-larga-1', name: 'Cajero B', role: Role.CASHIER })).resolves.toBeDefined();

      await expect(users.create(a, { email: 'CAJERO', password: 'clave-larga-1', name: 'Otro', role: Role.CASHIER })).rejects.toBeInstanceOf(ConflictException);
    });

    it('el aviso de repetido no revela a qué otro local pertenece', async () => {
      await users.create(a, { email: 'cajero', password: 'clave-larga-1', name: 'A', role: Role.CASHIER });
      const error: any = await users.create(a, { email: 'cajero', password: 'clave-larga-1', name: 'A2', role: Role.CASHIER }).catch((e) => e);

      expect(error.message).toMatch(/en tu local/);
    });
  });

  describe('datos del local para confirmar el código', () => {
    it('devuelve el nombre y el logo, sin datos internos', async () => {
      await prisma.tenant.update({ where: { id: a }, data: { city: 'Salta' } });

      const info = await auth.localInfo(' NUOVO-caffe ');

      expect(info).toEqual({ code: 'nuovo-caffe', name: 'Nuovo Caffe', city: 'Salta', logoUrl: null });
    });

    it('un código que no existe da 404', async () => {
      await expect(auth.localInfo('no-existe')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('códigos de local', () => {
    it('se arman con el nombre, sin tildes, y no se repiten', async () => {
      expect(await freeLoginCode(prisma, 'Café Ñandú')).toBe('cafe-nandu');
      await prisma.tenant.create({ data: { name: 'Café Ñandú', loginCode: 'cafe-nandu' } });
      expect(await freeLoginCode(prisma, 'Café Ñandú')).toBe('cafe-nandu-2');
      expect(await freeLoginCode(prisma, '!!')).toMatch(LOGIN_CODE_RE);
    });

    it('el dueño puede cambiar el código de su local, con las reglas y sin repetir el de otro', async () => {
      expect((await settings.update(a, { loginCode: ' Nuevo-Cafe ' })).loginCode).toBe('nuevo-cafe');

      await expect(settings.update(a, { loginCode: 'la-pizzeria' })).rejects.toBeInstanceOf(ConflictException);
      await expect(settings.update(a, { loginCode: 'ab' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(settings.update(a, { loginCode: 'con espacios' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(settings.update(a, { loginCode: '-empieza-con-guion' })).rejects.toBeInstanceOf(BadRequestException);
      expect((await settings.get(a)).loginCode).toBe('nuevo-cafe');
    });

    it('después de cambiarlo, el código viejo deja de servir', async () => {
      await user(a, 'mozo', 'clave-del-local-a');
      await settings.update(a, { loginCode: 'nuevo-cafe' });

      await expect(auth.login('mozo', 'clave-del-local-a', 'nuovo-caffe')).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(auth.login('mozo', 'clave-del-local-a', 'nuevo-cafe')).resolves.toBeDefined();
    });
  });
});
