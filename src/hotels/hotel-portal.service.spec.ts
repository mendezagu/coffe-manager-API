// @nestjs/jwt es ESM y jest no lo carga: se reemplaza por un JwtService de mentira que firma en base64
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { BadRequestException, ConflictException, ExecutionContext, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient, VoucherStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { HotelUserGuard } from './hotel-auth.guard';
import { HotelPortalService } from './hotel-portal.service';
import { HotelsAdminService } from './hotels-admin.service';
import { HotelsService } from './hotels.service';
import { PlatformAuthService, PlatformUserGuard } from './platform-auth';
import { PlatformTenantsService } from './platform-tenants.service';
import * as bcrypt from 'bcryptjs';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

class FakeJwt {
  async signAsync(payload: object) {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }
  decode(token: string) {
    return JSON.parse(Buffer.from(token, 'base64url').toString());
  }
  async verifyAsync(token: string) {
    try {
      return this.decode(token);
    } catch {
      throw new Error('jwt malformed');
    }
  }
}

describe('Portal del hotel y alta de restaurantes', () => {
  let prisma: PrismaService;
  let jwt: FakeJwt;
  let portal: HotelPortalService;
  let admin: HotelsAdminService;
  let hotels: HotelsService;
  let tenants: PlatformTenantsService;
  let platformAuth: PlatformAuthService;
  let tenantId: string;
  let hotelId: string;
  let otherHotelId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    jwt = new FakeJwt();
    portal = new HotelPortalService(prisma, jwt as unknown as JwtService);
    admin = new HotelsAdminService(prisma);
    hotels = new HotelsService(prisma);
    tenants = new PlatformTenantsService(prisma);
    platformAuth = new PlatformAuthService(prisma, jwt as unknown as JwtService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    await prisma.hotel.deleteMany({});
    await prisma.platformUser.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Pizzería' } })).id;
    hotelId = (await admin.createHotel({ name: 'Hotel Alpes', slug: 'alpes', accessCode: 'ALPES-OCT' })).id;
    otherHotelId = (await admin.createHotel({ name: 'Hotel Mar', slug: 'mar', accessCode: 'MAR-OCT' })).id;
    await admin.setPartner(hotelId, { tenantId, discountPct: 10 });
    await admin.setPartner(otherHotelId, { tenantId, discountPct: 20 });
    await admin.createHotelUser(hotelId, { email: 'Recepcion@Alpes.com', password: 'clave-larga-1' });
  });

  const ctx = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }), getHandler: () => ({}), getClass: () => ({}) }) as unknown as ExecutionContext;

  describe('acceso', () => {
    it('el hotel entra con su email y contraseña y recibe un token de hotel', async () => {
      const res = await portal.login(' recepcion@alpes.com ', 'clave-larga-1');

      expect(res.user).toEqual(expect.objectContaining({ email: 'recepcion@alpes.com', hotelName: 'Hotel Alpes' }));
      expect(jwt.decode(res.accessToken)).toEqual(expect.objectContaining({ typ: 'hotel' }));
    });

    it('contraseña mala, usuario inexistente o acceso dado de baja: mismo rechazo', async () => {
      await expect(portal.login('recepcion@alpes.com', 'otra')).rejects.toThrow(UnauthorizedException);
      await expect(portal.login('nadie@alpes.com', 'clave-larga-1')).rejects.toThrow(UnauthorizedException);

      const user = await prisma.hotelUser.findFirstOrThrow();
      await admin.updateHotelUser(user.id, { active: false });
      await expect(portal.login('recepcion@alpes.com', 'clave-larga-1')).rejects.toThrow(UnauthorizedException);
    });

    it('el token de hotel abre el portal pero NO el resto de la API, y el del personal no abre el portal', async () => {
      const { accessToken } = await portal.login('recepcion@alpes.com', 'clave-larga-1');
      const tenantUser = await prisma.user.create({
        data: { tenantId, email: 'admin@pizzeria.com', name: 'Ana', role: 'ADMIN', passwordHash: 'x' },
      });
      const staffToken = await jwt.signAsync({ sub: tenantUser.id });

      await expect(new HotelUserGuard(jwt as unknown as JwtService, prisma).canActivate(ctx({ authorization: `Bearer ${accessToken}` }))).resolves.toBe(true);
      await expect(new HotelUserGuard(jwt as unknown as JwtService, prisma).canActivate(ctx({ authorization: `Bearer ${staffToken}` }))).rejects.toThrow(UnauthorizedException);
      await expect(new HotelUserGuard(jwt as unknown as JwtService, prisma).canActivate(ctx({}))).rejects.toThrow(UnauthorizedException);

      const general = new JwtAuthGuard(new Reflector(), jwt as unknown as JwtService, prisma);
      await expect(general.canActivate(ctx({ authorization: `Bearer ${accessToken}` }))).rejects.toThrow(UnauthorizedException);
      await expect(general.canActivate(ctx({ authorization: `Bearer ${staffToken}` }))).resolves.toBe(true);
    });

    it('dar de baja el acceso corta el token que ya estaba emitido', async () => {
      const { accessToken } = await portal.login('recepcion@alpes.com', 'clave-larga-1');
      await admin.updateHotelUser((await prisma.hotelUser.findFirstOrThrow()).id, { active: false });

      await expect(new HotelUserGuard(jwt as unknown as JwtService, prisma).canActivate(ctx({ authorization: `Bearer ${accessToken}` }))).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('código y resumen', () => {
    it('el hotel cambia su código: el nuevo sirve y el viejo no', async () => {
      await portal.setAccessCode(hotelId, ' ALPES-NOV ');

      await expect(hotels.issueVoucher('alpes', { tenantId, guestName: 'Lucía', accessCode: 'ALPES-OCT' })).rejects.toThrow();
      await expect(hotels.issueVoucher('alpes', { tenantId, guestName: 'Lucía', accessCode: 'alpes nov' })).resolves.toBeDefined();
      await expect(portal.setAccessCode(hotelId, 'ab')).rejects.toThrow(BadRequestException);
    });

    it('el resumen cuenta emitidos, canjeados, anulados y vencidos, solo de SU hotel', async () => {
      const ask = (name: string) => hotels.issueVoucher('alpes', { tenantId, guestName: name, accessCode: 'ALPES-OCT' });
      const used = await ask('Ana');
      await ask('Beto');
      const cancelled = await ask('Carla');
      const old = await ask('Dani');
      await prisma.hotelVoucher.update({ where: { code: used.code }, data: { status: VoucherStatus.REDEEMED, redeemedAt: new Date() } });
      await prisma.hotelVoucher.update({ where: { code: cancelled.code }, data: { status: VoucherStatus.CANCELLED } });
      await prisma.hotelVoucher.update({ where: { code: old.code }, data: { validTo: new Date(Date.now() - 1000) } });
      await hotels.issueVoucher('mar', { tenantId, guestName: 'Otro', accessCode: 'MAR-OCT' }); // de otro hotel

      const s = await portal.summary(hotelId);

      expect(s.hotel).toEqual(expect.objectContaining({ name: 'Hotel Alpes', accessCode: 'ALPES-OCT' }));
      expect(s.totals).toEqual({ issued: 4, redeemed: 1, cancelled: 1, expired: 1 });
      expect(s.byRestaurant).toEqual([{ name: 'Pizzería', issued: 4, redeemed: 1 }]);
      expect(s.recent).toHaveLength(4);
      expect(s.recent.map((v) => v.guestName)).not.toContain('Otro');
      expect(s.recent.find((v) => v.guestName === 'Dani')?.status).toBe('EXPIRED');
      // el hotel no ve los códigos de los vouchers
      expect(JSON.stringify(s.recent)).not.toContain(used.code);
    });

    it('el hotel anula un voucher sin usar, pero no uno ya usado ni uno de otro hotel', async () => {
      const mine = await hotels.issueVoucher('alpes', { tenantId, guestName: 'Ana', accessCode: 'ALPES-OCT' });
      const theirs = await hotels.issueVoucher('mar', { tenantId, guestName: 'Beto', accessCode: 'MAR-OCT' });
      const idOf = async (code: string) => (await prisma.hotelVoucher.findUniqueOrThrow({ where: { code } })).id;

      await expect(portal.cancelVoucher(hotelId, await idOf(theirs.code))).rejects.toThrow(NotFoundException);
      await expect(portal.cancelVoucher(hotelId, await idOf(mine.code))).resolves.toEqual(expect.objectContaining({ status: 'CANCELLED' }));
      await expect(portal.cancelVoucher(hotelId, await idOf(mine.code))).rejects.toThrow(NotFoundException);
      await expect(hotels.validate(tenantId, mine.code)).rejects.toThrow(/anulado/);
    });
  });

  describe('alta desde el panel del dueño', () => {
    it('crea un restaurante con su administrador, que puede entrar', async () => {
      const t = await tenants.create({ name: ' Parrilla Sur ', adminEmail: 'Dueno@Parrilla.com', password: 'clave-larga-1' });

      expect(t).toEqual(expect.objectContaining({ name: 'Parrilla Sur', plan: 'pro', adminEmail: 'dueno@parrilla.com' }));
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dueno@parrilla.com' } });
      expect(user).toEqual(expect.objectContaining({ role: 'ADMIN', tenantId: t.id }));
      expect((await tenants.list()).map((x) => x.name)).toContain('Parrilla Sur');
    });

    it('valida los datos y no repite emails', async () => {
      await tenants.create({ name: 'A', adminEmail: 'a@a.com', password: 'clave-larga-1' });

      await expect(tenants.create({ name: 'B', adminEmail: 'a@a.com', password: 'clave-larga-1' })).rejects.toThrow(ConflictException);
      await expect(tenants.create({ name: '', adminEmail: 'b@b.com', password: 'clave-larga-1' })).rejects.toThrow(BadRequestException);
      await expect(tenants.create({ name: 'B', adminEmail: 'no-es-mail', password: 'clave-larga-1' })).rejects.toThrow(BadRequestException);
      await expect(tenants.create({ name: 'B', adminEmail: 'b@b.com', password: 'corta' })).rejects.toThrow(BadRequestException);
      await expect(tenants.create({ name: 'B', adminEmail: 'b@b.com', password: 'clave-larga-1', plan: 'inventado' })).rejects.toThrow(BadRequestException);
    });

    it('crea accesos de hotel, no repite emails y permite cambiar la contraseña', async () => {
      await expect(admin.createHotelUser(hotelId, { email: 'recepcion@alpes.com', password: 'clave-larga-1' })).rejects.toThrow(ConflictException);
      await expect(admin.createHotelUser(hotelId, { email: 'x@x.com', password: 'corta' })).rejects.toThrow(BadRequestException);
      await expect(admin.createHotelUser('nada', { email: 'x@x.com', password: 'clave-larga-1' })).rejects.toThrow(NotFoundException);

      const user = await prisma.hotelUser.findFirstOrThrow();
      await admin.updateHotelUser(user.id, { password: 'nueva-clave-2' });
      await expect(portal.login('recepcion@alpes.com', 'clave-larga-1')).rejects.toThrow(UnauthorizedException);
      await expect(portal.login('recepcion@alpes.com', 'nueva-clave-2')).resolves.toBeDefined();
      expect((await admin.listHotels()).find((h) => h.id === hotelId)?.users).toHaveLength(1);
    });
  });

  describe('consola de plataforma (el dueño de Tavolapp)', () => {
    const owner = async () =>
      prisma.platformUser.create({ data: { email: 'dueno@tavolapp.app', name: 'Dueño', passwordHash: await bcrypt.hash('clave-larga-123', 4) } });
    const guard = () => new PlatformUserGuard(jwt as unknown as JwtService, prisma);

    it('entra con su email y contraseña y recibe un token de plataforma', async () => {
      await owner();

      const res = await platformAuth.login(' Dueno@Tavolapp.app ', 'clave-larga-123');

      expect(res.user).toEqual(expect.objectContaining({ email: 'dueno@tavolapp.app' }));
      expect(jwt.decode(res.accessToken)).toEqual(expect.objectContaining({ typ: 'platform' }));
      await expect(platformAuth.login('dueno@tavolapp.app', 'mala')).rejects.toThrow(UnauthorizedException);
      await expect(platformAuth.login('otro@tavolapp.app', 'clave-larga-123')).rejects.toThrow(UnauthorizedException);
    });

    it('un administrador de restaurante o de hotel NO es dueño de la plataforma', async () => {
      const hotelToken = (await portal.login('recepcion@alpes.com', 'clave-larga-1')).accessToken;
      const admin = await prisma.user.create({ data: { tenantId, email: 'admin@pizzeria.com', name: 'Ana', role: 'ADMIN', passwordHash: 'x' } });
      const staffToken = await jwt.signAsync({ sub: admin.id });

      await expect(guard().canActivate(ctx({ authorization: `Bearer ${hotelToken}` }))).rejects.toThrow(UnauthorizedException);
      await expect(guard().canActivate(ctx({ authorization: `Bearer ${staffToken}` }))).rejects.toThrow(UnauthorizedException);
      await expect(guard().canActivate(ctx({}))).rejects.toThrow(UnauthorizedException);
    });

    it('su token no sirve en la API de los restaurantes ni en el portal del hotel, y dar de baja la cuenta lo corta', async () => {
      const user = await owner();
      const { accessToken } = await platformAuth.login('dueno@tavolapp.app', 'clave-larga-123');
      const bearer = ctx({ authorization: `Bearer ${accessToken}` });

      await expect(guard().canActivate(bearer)).resolves.toBe(true);
      await expect(new JwtAuthGuard(new Reflector(), jwt as unknown as JwtService, prisma).canActivate(bearer)).rejects.toThrow(UnauthorizedException);
      await expect(new HotelUserGuard(jwt as unknown as JwtService, prisma).canActivate(bearer)).rejects.toThrow(UnauthorizedException);

      await prisma.platformUser.update({ where: { id: user.id }, data: { active: false } });
      await expect(guard().canActivate(bearer)).rejects.toThrow(UnauthorizedException);
      await expect(platformAuth.login('dueno@tavolapp.app', 'clave-larga-123')).rejects.toThrow(UnauthorizedException);
    });
  });
});
