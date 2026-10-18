/**
 * Administra los hoteles aliados (por ahora sin pantalla: se hace desde acá).
 *
 *   npm run hotel -- create --name "Hotel Los Alpes" --slug los-alpes --code ALPES-OCT [--days 3] [--contact "Marta 11 5555-1234"]
 *   npm run hotel -- link   --hotel los-alpes --tenant "La Pizzería" --discount 10 [--conditions "Lunes a jueves"]
 *   npm run hotel -- code   --hotel los-alpes --code ALPES-NOV      (cambia el código vigente del hotel)
 *   npm run hotel -- list
 *
 * --tenant acepta el nombre exacto del negocio o su id.
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const command = process.argv[2];
  const prisma = new PrismaClient();
  try {
    if (command === 'create') {
      const name = arg('name');
      const slug = arg('slug')?.toLowerCase();
      const code = arg('code');
      if (!name || !slug || !code) fail('Uso: npm run hotel -- create --name "Hotel" --slug hotel-slug --code CODIGO');
      if (!/^[a-z0-9-]{1,60}$/.test(slug)) fail('El slug solo puede tener minúsculas, números y guiones.');
      const days = Number(arg('days') ?? 3);
      if (!Number.isInteger(days) || days < 1 || days > 60) fail('--days tiene que ser un entero entre 1 y 60.');
      const hotel = await prisma.hotel.create({
        data: { name: name.trim(), slug, accessCode: code.trim(), voucherValidDays: days, contact: arg('contact') ?? '' },
      });
      console.log(`Hotel "${hotel.name}" creado. Página del huésped: /hotel/${hotel.slug}  (código vigente: ${hotel.accessCode})`);
    } else if (command === 'link') {
      const slug = arg('hotel');
      const tenantRef = arg('tenant');
      const discount = Number(arg('discount'));
      if (!slug || !tenantRef || !(discount > 0 && discount <= 100)) {
        fail('Uso: npm run hotel -- link --hotel slug --tenant "Negocio" --discount 10');
      }
      const hotel = await prisma.hotel.findUnique({ where: { slug } });
      if (!hotel) fail(`No existe el hotel "${slug}".`);
      const tenants = await prisma.tenant.findMany({ where: { OR: [{ id: tenantRef }, { name: tenantRef }] } });
      if (tenants.length !== 1) fail(tenants.length ? 'Hay varios negocios con ese nombre: usá el id.' : `No existe el negocio "${tenantRef}".`);
      const tenant = tenants[0];
      await prisma.hotelPartner.upsert({
        where: { hotelId_tenantId: { hotelId: hotel.id, tenantId: tenant.id } },
        create: { hotelId: hotel.id, tenantId: tenant.id, discountPct: discount, conditions: arg('conditions') ?? '' },
        update: { discountPct: discount, active: true, ...(arg('conditions') !== undefined && { conditions: arg('conditions') }) },
      });
      console.log(`"${tenant.name}" ofrece ${discount}% a los huéspedes de "${hotel.name}".`);
    } else if (command === 'code') {
      const slug = arg('hotel');
      const code = arg('code');
      if (!slug || !code) fail('Uso: npm run hotel -- code --hotel slug --code NUEVO-CODIGO');
      const { count } = await prisma.hotel.updateMany({ where: { slug }, data: { accessCode: code.trim() } });
      if (!count) fail(`No existe el hotel "${slug}".`);
      console.log(`Código de "${slug}" actualizado. Los vouchers ya emitidos siguen valiendo hasta que venzan.`);
    } else if (command === 'list') {
      const hotels = await prisma.hotel.findMany({ include: { partners: { include: { tenant: true } } }, orderBy: { name: 'asc' } });
      for (const h of hotels) {
        console.log(`${h.name} (/hotel/${h.slug}) código: ${h.accessCode}${h.active ? '' : '  [INACTIVO]'}`);
        for (const p of h.partners) console.log(`   - ${p.tenant.name}: ${p.discountPct}%${p.active ? '' : '  [INACTIVO]'}`);
      }
      if (!hotels.length) console.log('No hay hoteles cargados.');
    } else {
      fail('Comandos: create | link | code | list');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
