/**
 * Migración de un solo uso: copia los datos del sistema anterior (MongoDB Atlas) a Postgres.
 *
 *   npm run migrate:data                       → PRUEBA: lee, valida y muestra qué haría. No escribe nada.
 *   npm run migrate:data -- --apply            → copia los datos (todo en UNA transacción: si algo no cuadra, no queda nada)
 *   npm run migrate:data -- --apply --force    → antes borra lo ya cargado en el negocio de destino (para repetir el ensayo)
 *
 * Opciones: --mongo-db <nombre>   base de Mongo a leer (por defecto, la de MONGO_URI)
 *           --tenant "<nombre>"   negocio de destino (por defecto, el primero)
 *           --skip-open-orders    no copia los pedidos abiertos de las mesas
 *
 * Mongo es de SOLO LECTURA: este script nunca escribe ni borra nada allí.
 * Variables: MONGO_URI (origen) y DATABASE_URL (Postgres de destino).
 */
import 'dotenv/config';
import * as dns from 'dns';
import { MongoClient, ObjectId } from 'mongodb';
import { PrismaClient } from '@prisma/client';

// El DNS local a veces no resuelve el registro SRV de Atlas
dns.setServers(['8.8.8.8', '1.1.1.1']);

const flag = (name: string) => process.argv.includes(`--${name}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const APPLY = flag('apply');
const FORCE = flag('force');
const SKIP_OPEN = flag('skip-open-orders');

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const createdAt = (id: unknown): Date => (id instanceof ObjectId ? id.getTimestamp() : new Date());

const log = (msg = '') => console.log(msg);
function fail(msg: string): never {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

interface MongoTable {
  _id: ObjectId;
  name?: string;
  available?: boolean;
  orders?: { _id?: ObjectId; menuItem?: ObjectId; quantity?: number }[];
  linkedTables?: unknown[];
  controlledBy?: unknown;
  waiterId?: unknown;
}

async function main() {
  if (!process.env.MONGO_URI) fail('Falta MONGO_URI (la base de Mongo de origen).');
  if (!process.env.DATABASE_URL) fail('Falta DATABASE_URL (el Postgres de destino).');

  const target = new URL(process.env.DATABASE_URL.replace(/^postgres(ql)?:/, 'http:'));
  log(`Destino: Postgres ${target.hostname}${target.pathname}`);
  log(APPLY ? 'Modo: APLICAR (escribe en Postgres)' : 'Modo: PRUEBA (no escribe nada). Usá --apply para copiar de verdad.');

  // ---------- 1) Leer Mongo (solo lectura) ----------
  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db(arg('mongo-db'));
  log(`Origen: Mongo, base "${db.databaseName}" (solo lectura)\n`);

  const [waiters, menu, tables, balances] = await Promise.all([
    db.collection('waiters').find().sort({ _id: 1 }).toArray(),
    db.collection('menuitems').find().sort({ _id: 1 }).toArray(),
    db.collection<MongoTable>('tables').find().sort({ _id: 1 }).toArray(),
    db.collection('balances').find().sort({ date: 1, _id: 1 }).toArray(),
  ]);
  await mongo.close();

  log(`Leído de Mongo: ${waiters.length} mozos, ${menu.length} platos, ${tables.length} mesas, ${balances.length} ventas`);

  // ---------- 2) Validar antes de escribir ----------
  const problems: string[] = [];
  const warnings: string[] = [];

  const waiterIds = new Set(waiters.map((w) => String(w._id)));
  const menuIds = new Set(menu.map((m) => String(m._id)));
  const tableNames = new Set<string>();

  for (const w of waiters) if (!text(w.name)) problems.push(`Mozo ${w._id} sin nombre`);
  for (const m of menu) {
    if (!text(m.name)) problems.push(`Plato ${m._id} sin nombre`);
    if (!(Number(m.price) >= 0)) problems.push(`Plato "${m.name}" con precio inválido (${m.price})`);
  }
  for (const t of tables) {
    const name = text(t.name);
    if (!name) problems.push(`Mesa ${t._id} sin nombre`);
    if (tableNames.has(name)) warnings.push(`Nombre de mesa repetido: "${name}"`);
    tableNames.add(name);
    if (t.waiterId && !waiterIds.has(String(t.waiterId))) warnings.push(`Mesa "${name}": su mozo ya no existe (queda sin mozo)`);
    for (const o of t.orders ?? []) {
      if (!o.menuItem || !menuIds.has(String(o.menuItem))) problems.push(`Mesa "${name}": un pedido apunta a un plato que no existe`);
    }
  }
  const seenOrder = new Set<string>();
  for (const b of balances) {
    if (!(Number(b.totalAmount) >= 0)) problems.push(`Venta ${b._id} con total inválido (${b.totalAmount})`);
    if (!b.date) problems.push(`Venta ${b._id} sin fecha`);
    const key = String(b.orderId ?? b._id);
    if (seenOrder.has(key)) problems.push(`Venta con identificador repetido: ${key}`);
    seenOrder.add(key);
  }

  const openTables = tables.filter((t) => (t.orders ?? []).length > 0);
  if (openTables.length && !SKIP_OPEN) {
    warnings.push(
      `Hay ${openTables.length} mesa(s) con pedidos abiertos (${openTables.map((t) => t.name).join(', ')}): se copian como pendientes en cocina. ` +
        'Lo ideal es migrar cuando todas las mesas estén libres (o usá --skip-open-orders).',
    );
  }

  warnings.forEach((w) => log(`⚠ ${w}`));
  if (problems.length) {
    problems.forEach((p) => console.error(`✖ ${p}`));
    fail(`Se encontraron ${problems.length} problema(s) en los datos de origen. No se escribió nada.`);
  }
  log('✔ Los datos de origen están consistentes.\n');

  // ---------- 3) Destino ----------
  const prisma = new PrismaClient();
  try {
    const tenantName = arg('tenant');
    const tenant = tenantName
      ? await prisma.tenant.findFirst({ where: { name: tenantName } })
      : await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!tenant) fail('No hay ningún negocio en Postgres. Corré antes "npx prisma migrate deploy".');
    log(`Negocio de destino: "${tenant.name}" (${tenant.id})`);

    const existing = {
      mesas: await prisma.table.count({ where: { tenantId: tenant.id } }),
      platos: await prisma.menuItem.count({ where: { tenantId: tenant.id } }),
      mozos: await prisma.waiter.count({ where: { tenantId: tenant.id } }),
      ventas: await prisma.sale.count({ where: { tenantId: tenant.id } }),
    };
    const hasData = Object.values(existing).some((n) => n > 0);
    if (hasData) {
      log(`El negocio ya tiene datos: ${JSON.stringify(existing)}`);
      if (!FORCE) fail('Para no mezclar datos, el script se detiene. Usá --force para borrar lo cargado y volver a copiar.');
      log('--force: se borrará lo cargado (mesas, platos, mozos, ventas) antes de copiar.');
    }

    if (!APPLY) {
      log('\nPRUEBA terminada: no se escribió nada. Si todo se ve bien, repetí con --apply.');
      return;
    }

    // ---------- 4) Copiar, todo en una transacción ----------
    const result = await prisma.$transaction(
      async (tx) => {
        if (hasData) {
          await tx.sale.deleteMany({ where: { tenantId: tenant.id } });
          await tx.table.deleteMany({ where: { tenantId: tenant.id } });
          await tx.menuItem.deleteMany({ where: { tenantId: tenant.id } });
          await tx.waiter.deleteMany({ where: { tenantId: tenant.id } });
        }

        // Mozos
        const waiterMap = new Map<string, string>();
        for (const w of waiters) {
          const created = await tx.waiter.create({ data: { tenantId: tenant.id, name: text(w.name) } });
          waiterMap.set(String(w._id), created.id);
        }

        // Platos (sin categoría ni promo: eso se carga después desde Administrar)
        const menuMap = new Map<string, string>();
        for (const m of menu) {
          const created = await tx.menuItem.create({
            data: { tenantId: tenant.id, name: text(m.name), price: round2(Number(m.price)), quantity: Number(m.quantity) > 0 ? Number(m.quantity) : 1 },
          });
          menuMap.set(String(m._id), created.id);
        }

        // Mesas (en el orden en que se crearon, así conservan su lugar) y sus pedidos abiertos
        const tableMap = new Map<string, string>();
        let orderLines = 0;
        for (const t of tables) {
          const lines = SKIP_OPEN ? [] : t.orders ?? [];
          const opened = lines.length ? new Date(Math.min(...lines.map((o) => createdAt(o._id).getTime()))) : null;
          const created = await tx.table.create({
            data: {
              tenantId: tenant.id,
              name: text(t.name),
              available: lines.length === 0,
              openedAt: opened,
              waiterId: t.waiterId ? waiterMap.get(String(t.waiterId)) ?? null : null,
            },
          });
          tableMap.set(String(t._id), created.id);
          for (const o of lines) {
            await tx.order.create({
              data: {
                tableId: created.id,
                menuItemId: menuMap.get(String(o.menuItem)),
                quantity: Math.max(1, Number(o.quantity) || 1),
                createdAt: createdAt(o._id),
                updatedAt: createdAt(o._id),
              },
            });
            orderLines += 1;
          }
        }
        // Mesas vinculadas (si las hubiera)
        for (const t of tables) {
          const parent = tableMap.get(String(t._id));
          const link = t.controlledBy ? tableMap.get(String(t.controlledBy)) : undefined;
          if (parent && link) await tx.table.update({ where: { id: parent }, data: { controlledById: link, available: false } });
        }

        // Ventas: el sistema anterior no guardaba el detalle de platos, solo el total y el método de pago
        let salesTotal = 0;
        for (const b of balances) {
          const total = round2(Number(b.totalAmount));
          const method = text(b.paymentMethod) || 'efectivo';
          salesTotal += total;
          await tx.sale.create({
            data: {
              tenantId: tenant.id,
              checkoutId: String(b.orderId ?? `mongo-${b._id}`),
              tableName: text(b.tableName),
              waiterName: text(b.waiterName) || 'Sin asignar',
              paymentMethod: method,
              grossTotal: total,
              totalAmount: total,
              date: new Date(b.date),
              payments: { create: [{ method, amount: total }] },
            },
          });
        }

        // ---------- 5) Control: lo copiado tiene que coincidir con el origen, o se revierte todo ----------
        const after = {
          mozos: await tx.waiter.count({ where: { tenantId: tenant.id } }),
          platos: await tx.menuItem.count({ where: { tenantId: tenant.id } }),
          mesas: await tx.table.count({ where: { tenantId: tenant.id } }),
          pedidos: await tx.order.count({ where: { table: { tenantId: tenant.id } } }),
          ventas: await tx.sale.count({ where: { tenantId: tenant.id } }),
        };
        const sum = await tx.sale.aggregate({ where: { tenantId: tenant.id }, _sum: { totalAmount: true } });
        const copiedTotal = round2(sum._sum.totalAmount ?? 0);
        const expected = { mozos: waiters.length, platos: menu.length, mesas: tables.length, pedidos: orderLines, ventas: balances.length };
        for (const k of Object.keys(expected) as (keyof typeof expected)[]) {
          if (after[k] !== expected[k]) throw new Error(`Control fallido en ${k}: origen ${expected[k]}, destino ${after[k]}`);
        }
        if (Math.abs(copiedTotal - round2(salesTotal)) > 0.01) throw new Error(`Control fallido en el total vendido: origen ${round2(salesTotal)}, destino ${copiedTotal}`);
        return { after, copiedTotal };
      },
      { timeout: 120_000, maxWait: 20_000 },
    );

    log('\n✔ Migración aplicada y verificada:');
    log(`   Mozos:    ${result.after.mozos}`);
    log(`   Platos:   ${result.after.platos}`);
    log(`   Mesas:    ${result.after.mesas} (${result.after.pedidos} líneas de pedido abiertas)`);
    log(`   Ventas:   ${result.after.ventas} por un total de ${result.copiedTotal}`);
    log('\nMongo no se tocó. Siguiente paso: revisar en la app que todo se vea bien.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('\n✖ Falló la migración. Si estaba aplicando, no quedó nada a medias (se revirtió).');
  console.error(e?.message ?? e);
  process.exit(1);
});
