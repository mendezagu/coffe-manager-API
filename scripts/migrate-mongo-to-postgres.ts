/**
 * Migración de un solo uso: copia los datos de MongoDB Atlas (MONGO_URI) a
 * Postgres (DATABASE_URL) vía Prisma. Nunca escribe/borra nada en Mongo —
 * solo lee. Ejecutar con: npm run migrate:data [-- --force]
 */
import * as dotenv from 'dotenv';
dotenv.config();

// El entorno local no siempre resuelve el SRV record de Atlas con el DNS
// por defecto — mismo workaround que tenía antes src/main.ts, pero acotado
// a este script (la app ya no habla con Mongo).
import * as dns from 'dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);

import mongoose from 'mongoose';
import { PrismaClient } from '@prisma/client';
import { Table, TableSchema } from '../src/table/schemas/table.schema';
import { MenuItem, MenuItemSchema } from '../src/menu-item/schemas/menu-item.schema';
import { Waiter, WaiterSchema } from '../src/waiter/schemas/waiter.schema';
import { Balance, BalanceSchema } from '../src/balance/schemas/balance.schema';

const prisma = new PrismaClient();

const TableModel = mongoose.model(Table.name, TableSchema);
const MenuItemModel = mongoose.model(MenuItem.name, MenuItemSchema);
const WaiterModel = mongoose.model(Waiter.name, WaiterSchema);
const BalanceModel = mongoose.model(Balance.name, BalanceSchema);

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('Falta MONGO_URI en .env');
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Conectado a MongoDB (solo lectura).');

  const force = process.argv.includes('--force');
  const existingTables = await prisma.table.count();
  if (existingTables > 0 && !force) {
    throw new Error(
      `Postgres ya tiene ${existingTables} mesa(s). Volvé a correr con --force para vaciar Postgres (nunca Mongo) y re-migrar, o usá una base limpia.`,
    );
  }
  if (force) {
    console.log('--force: vaciando Postgres antes de migrar (Mongo no se toca)...');
    await prisma.order.deleteMany({});
    await prisma.balance.deleteMany({});
    await prisma.table.deleteMany({});
    await prisma.menuItem.deleteMany({});
    await prisma.waiter.deleteMany({});
  }

  const waiterIdMap = new Map<string, string>();
  const menuItemIdMap = new Map<string, string>();
  const tableIdMap = new Map<string, string>();
  let danglingRefs = 0;

  // 1. Waiters (sin dependencias)
  const waiters = await WaiterModel.find().lean();
  for (const w of waiters as any[]) {
    const created = await prisma.waiter.create({ data: { name: w.name } });
    waiterIdMap.set(w._id.toString(), created.id);
  }
  console.log(`Waiters migrados: ${waiters.length}`);

  // 2. MenuItems (sin dependencias)
  const menuItems = await MenuItemModel.find().lean();
  for (const m of menuItems as any[]) {
    const created = await prisma.menuItem.create({
      data: { name: m.name, price: m.price, quantity: m.quantity ?? 1 },
    });
    menuItemIdMap.set(m._id.toString(), created.id);
  }
  console.log(`MenuItems migrados: ${menuItems.length}`);

  // 3. Tables — pasada 1: campos escalares + waiterId (controlledBy se resuelve después)
  const tables = await TableModel.find().lean();
  for (const t of tables as any[]) {
    let resolvedWaiterId: string | null = null;
    if (t.waiterId) {
      resolvedWaiterId = waiterIdMap.get(t.waiterId) ?? null;
      if (!resolvedWaiterId) {
        console.warn(`  ref colgante: mesa ${t._id} apunta a waiterId ${t.waiterId} inexistente`);
        danglingRefs++;
      }
    }
    const created = await prisma.table.create({
      data: {
        name: t.name,
        available: t.available,
        waiterId: resolvedWaiterId,
      },
    });
    tableIdMap.set(t._id.toString(), created.id);
  }
  console.log(`Tables migradas: ${tables.length}`);

  // 4. Orders — necesita los ids nuevos de Table y MenuItem
  let orderCount = 0;
  for (const t of tables as any[]) {
    const newTableId = tableIdMap.get(t._id.toString())!;
    for (const o of t.orders ?? []) {
      let newMenuItemId: string | null = null;
      if (o.menuItem) {
        newMenuItemId = menuItemIdMap.get(o.menuItem.toString()) ?? null;
        if (!newMenuItemId) {
          console.warn(`  ref colgante: orden en mesa ${t._id} apunta a menuItem ${o.menuItem} inexistente`);
          danglingRefs++;
        }
      }
      await prisma.order.create({
        data: {
          tableId: newTableId,
          menuItemId: newMenuItemId,
          quantity: o.quantity ?? 1,
          note: o.note ?? '',
        },
      });
      orderCount++;
    }
  }
  console.log(`Orders migradas: ${orderCount}`);

  // 5. Tables — pasada 2: controlledBy, ahora que todas las mesas tienen id nuevo
  for (const t of tables as any[]) {
    if (t.controlledBy) {
      const newId = tableIdMap.get(t._id.toString())!;
      const newParentId = tableIdMap.get(t.controlledBy) ?? null;
      if (!newParentId) {
        console.warn(`  ref colgante: mesa ${t._id} apunta a controlledBy ${t.controlledBy} inexistente`);
        danglingRefs++;
      }
      await prisma.table.update({ where: { id: newId }, data: { controlledById: newParentId } });
    }
  }

  // 6. Balances — sin FK, copia directa
  const balances = await BalanceModel.find().lean();
  for (const b of balances as any[]) {
    await prisma.balance.create({
      data: {
        orderId: b.orderId,
        tableName: b.tableName,
        waiterName: b.waiterName,
        totalAmount: b.totalAmount,
        paymentMethod: b.paymentMethod,
        date: b.date,
      },
    });
  }
  console.log(`Balances migrados: ${balances.length}`);

  if (danglingRefs > 0) {
    console.warn(`\n${danglingRefs} referencia(s) colgante(s) encontradas (datos preexistentes en Mongo) — no frenaron la migración.`);
  }

  // 7. Verificación de conteos
  console.log('\nVerificación de conteos:');
  const checks: [string, number, number][] = [
    ['waiters', waiters.length, await prisma.waiter.count()],
    ['menuItems', menuItems.length, await prisma.menuItem.count()],
    ['tables', tables.length, await prisma.table.count()],
    ['orders', orderCount, await prisma.order.count()],
    ['balances', balances.length, await prisma.balance.count()],
  ];
  let ok = true;
  for (const [name, mongoCount, pgCount] of checks) {
    const match = mongoCount === pgCount;
    ok = ok && match;
    console.log(`  ${name}: mongo=${mongoCount} postgres=${pgCount} ${match ? 'OK' : 'MISMATCH'}`);
  }
  if (!ok) {
    throw new Error('Verificación de conteos falló — revisar antes de dar la migración por completa.');
  }

  console.log('\nMigración completa y verificada.');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
    await prisma.$disconnect();
  });
