import { BadRequestException, ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

// @nestjs/jwt viene como módulo ESM y Jest no lo carga: se reemplaza por un firmador de mentira (el token es el payload en JSON)
jest.mock('@nestjs/jwt', () => ({ JwtService: class JwtService {} }));

// Corre contra la base de pruebas (coffee_manager_test), nunca contra la de desarrollo.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Cambio de contraseña', () => {
  let prisma: PrismaService;
  let jwt: JwtService;
  let auth: AuthService;
  let guard: JwtAuthGuard;
  let tenantId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    jwt = {
      signAsync: async (payload: object) => JSON.stringify(payload),
      verifyAsync: async (token: string) => JSON.parse(token),
    } as unknown as JwtService;
    auth = new AuthService(prisma, jwt);
    guard = new JwtAuthGuard(new Reflector(), jwt, prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Negocio A' } })).id;
  });

  const newUser = async (mustChangePassword: boolean, password = 'inicial123') =>
    prisma.user.create({
      data: {
        tenantId,
        email: 'dueno@test.com',
        name: 'Dueño',
        role: Role.ADMIN,
        passwordHash: await bcrypt.hash(password, 4),
        mustChangePassword,
      },
    });

  // Contexto mínimo para el guard: un request con token y la ruta que se quiere llamar
  const ctxFor = (token: string, handler: Function, cls: Function = class Otro {}) => {
    const request: any = { headers: { authorization: `Bearer ${token}` } };
    const context = {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  };

  it('el login avisa si la contraseña tiene que cambiarse', async () => {
    await newUser(true);
    const res = await auth.login('dueno@test.com', 'inicial123');
    expect(res.user.mustChangePassword).toBe(true);
  });

  it('cambiar la contraseña: la nueva sirve, la vieja no, y se apaga el aviso', async () => {
    const user = await newUser(true);
    await auth.changePassword(user.id, 'inicial123', 'nueva-clave-segura');

    expect((await auth.login('dueno@test.com', 'nueva-clave-segura')).user.mustChangePassword).toBe(false);
    await expect(auth.login('dueno@test.com', 'inicial123')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('pide la contraseña actual y rechaza una nueva corta o igual a la actual', async () => {
    const user = await newUser(false);
    await expect(auth.changePassword(user.id, 'incorrecta', 'nueva-clave-segura')).rejects.toBeInstanceOf(BadRequestException);
    await expect(auth.changePassword(user.id, 'inicial123', 'corta')).rejects.toBeInstanceOf(BadRequestException);
    await expect(auth.changePassword(user.id, 'inicial123', 'inicial123')).rejects.toBeInstanceOf(BadRequestException);
    // nada cambió
    expect((await auth.login('dueno@test.com', 'inicial123')).user.email).toBe('dueno@test.com');
  });

  it('mientras falte cambiar la contraseña, el servidor solo deja ver la sesión y cambiarla', async () => {
    const user = await newUser(true);
    const token = await jwt.signAsync({ sub: user.id });

    // una ruta cualquiera: bloqueada
    const blocked = ctxFor(token, function listarMesas() {});
    await expect(guard.canActivate(blocked.context)).rejects.toBeInstanceOf(ForbiddenException);

    // "me" y "cambiar contraseña": permitidas
    for (const method of ['me', 'changePassword'] as const) {
      const ok = ctxFor(token, AuthController.prototype[method], AuthController);
      await expect(guard.canActivate(ok.context)).resolves.toBe(true);
    }
  });

  describe('sesiones abiertas antes de cambiar la contraseña', () => {
    const tokenAt = (userId: string, iat: number) => JSON.stringify({ sub: userId, iat });

    it('una sesión anterior al cambio deja de valer, y la posterior sigue valiendo', async () => {
      const user = await newUser(false);
      const before = Math.floor(Date.now() / 1000) - 60;
      await auth.changePassword(user.id, 'inicial123', 'nueva-clave-segura');
      const after = Math.floor(Date.now() / 1000) + 1;

      await expect(guard.canActivate(ctxFor(tokenAt(user.id, before), function listarMesas() {}).context)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(guard.canActivate(ctxFor(tokenAt(user.id, after), function listarMesas() {}).context)).resolves.toBe(true);
    });

    it('cambiar la contraseña devuelve un token nuevo para seguir en la sesión actual', async () => {
      const user = await newUser(false);

      const res = await auth.changePassword(user.id, 'inicial123', 'nueva-clave-segura');

      expect(JSON.parse(res.accessToken)).toEqual({ sub: user.id });
    });

    it('una sesión sin fecha de emisión o de un usuario que nunca cambió la clave no se rechaza', async () => {
      const user = await newUser(false);

      await expect(guard.canActivate(ctxFor(tokenAt(user.id, 1), function listarMesas() {}).context)).resolves.toBe(true);
    });
  });

  it('con la contraseña ya cambiada, todas las rutas vuelven a estar disponibles', async () => {
    const user = await newUser(true);
    const token = await jwt.signAsync({ sub: user.id });
    await auth.changePassword(user.id, 'inicial123', 'nueva-clave-segura');

    const route = ctxFor(token, function listarMesas() {});
    await expect(guard.canActivate(route.context)).resolves.toBe(true);
    expect(route.request.user.mustChangePassword).toBe(false);
  });
});
