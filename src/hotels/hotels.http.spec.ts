// La librería de login es ESM y Jest (CommonJS) no la carga; acá no se usa el login (la pantalla del huésped es pública).
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule } from '../prisma/prisma.module';
import { HotelsPublicController } from './hotels.controller';
import { ReservationsService } from '../reservations/reservations.service';
import { HotelsService } from './hotels.service';

// Prueba por HTTP la pantalla pública del huésped (validación de lo que manda), contra la base de pruebas.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}
process.env.DATABASE_URL = TEST_DATABASE_URL;

describe('Hoteles · pedir un voucher por HTTP', () => {
  let app: INestApplication;
  let base: string;
  let prisma: PrismaClient;
  let tenantId: string;
  let ipCounter = 0;

  const ask = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/public/hotel/alpes-http/vouchers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipCounter}` }, // cada pedido desde otra "conexión"
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const valid = () => ({ restaurantId: tenantId, guestName: 'Lucía Pérez', document: '30.123.456', accessCode: 'ALPES-HTTP' });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32);
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [HotelsPublicController],
      providers: [HotelsService, ReservationsService],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.listen(0);
    base = `http://localhost:${app.getHttpServer().address().port}`;
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.hotel.deleteMany({ where: { slug: 'alpes-http' } });
    await prisma.tenant.deleteMany({ where: { name: 'Pizzería HTTP' } });
    tenantId = (await prisma.tenant.create({ data: { plan: 'benefits', name: 'Pizzería HTTP', requireOpenRegister: false } })).id;
    const hotel = await prisma.hotel.create({ data: { name: 'Hotel Alpes', slug: 'alpes-http', accessCode: 'ALPES-HTTP' } });
    await prisma.hotelPartner.create({ data: { hotelId: hotel.id, tenantId, discountPct: 10 } });
  });

  afterAll(async () => {
    await prisma.hotel.deleteMany({ where: { slug: 'alpes-http' } });
    await prisma.tenant.deleteMany({ where: { name: 'Pizzería HTTP' } });
    await prisma.$disconnect();
    await app.close();
  });

  it('sin el documento el pedido se rechaza', async () => {
    const { document: _omit, ...withoutDocument } = valid();

    const res = await ask(withoutDocument);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('document');
    expect(await prisma.hotelVoucher.count({ where: { hotel: { slug: 'alpes-http' } } })).toBe(0);
  });

  it('con solo el nombre (sin apellido) o con un documento inválido se rechaza con un mensaje claro', async () => {
    const noSurname = await ask({ ...valid(), guestName: 'Lucía' });
    expect(noSurname.status).toBe(400);
    expect(noSurname.json.message).toMatch(/nombre y apellido/);

    const badDoc = await ask({ ...valid(), document: '1-2-3-4-5-6-7-8-9-0-1-2-3-4-5-6-7' });
    expect(badDoc.status).toBe(400);

    const shortDoc = await ask({ ...valid(), document: '12' });
    expect(shortDoc.status).toBe(400);
  });

  it('con todos los datos entrega el voucher, y pedir otro devuelve el mismo', async () => {
    const first = await ask(valid());
    expect(first.status).toBe(201);
    expect(first.json.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(first.json.reused).toBe(false);

    const again = await ask({ ...valid(), document: '30123456' }); // el mismo documento, escrito sin puntos
    expect(again.status).toBe(201);
    expect(again.json.code).toBe(first.json.code);
    expect(again.json.reused).toBe(true);
  });

  describe('estado de los vouchers del celular', () => {
    const status = async (body: unknown) => {
      const res = await fetch(`${base}/api/public/hotel/alpes-http/vouchers/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipCounter}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as any };
    };

    it('devuelve el estado de un voucher que el huésped ya pidió, sin sus datos personales', async () => {
      const issued = await ask(valid());

      const res = await status({ codes: [issued.json.code.toLowerCase()] });

      expect(res.status).toBe(201);
      expect(res.json).toEqual([expect.objectContaining({ code: issued.json.code, status: 'ISSUED', restaurantName: 'Pizzería HTTP', discountPct: 10 })]);
      expect(JSON.stringify(res.json)).not.toContain('Lucía');
    });

    it('rechaza códigos con formato raro, más de 20 códigos o un pedido sin lista', async () => {
      expect((await status({ codes: ['<script>'] })).status).toBe(400);
      expect((await status({ codes: Array.from({ length: 21 }, (_, i) => `ABC${100 + i}`) })).status).toBe(400);
      expect((await status({})).status).toBe(400);
      expect((await status({ codes: 'ABC234' })).status).toBe(400);
    });

    it('con un hotel inexistente responde 404', async () => {
      const res = await fetch(`${base}/api/public/hotel/no-existe/vouchers/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${++ipCounter}` },
        body: JSON.stringify({ codes: ['ABC234'] }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('nunca devuelve el documento ni su huella', async () => {
    const res = await ask(valid());

    const text = JSON.stringify(res.json);
    expect(text).not.toContain('30123456');
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});
