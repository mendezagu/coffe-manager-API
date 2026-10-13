import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TablesService } from '../tables/tables.service';
import { MAX_PENDING_PER_TABLE, MIN_SECONDS_BETWEEN_SENDS, QrService } from './qr.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)',
  );
}

describe('Pedido por QR', () => {
  let prisma: PrismaService;
  let tables: TablesService;
  let qr: QrService;

  let tenantId: string;
  let otherTenantId: string;
  let table1: { id: string; qrToken: string | null };
  let table2: { id: string; qrToken: string | null };
  let otherTable: { id: string; qrToken: string | null };
  let burger: { id: string };
  let cola: { id: string };
  let foreignDish: { id: string };
  let sizeGroup: { id: string };
  let sizeBig: { id: string };

  // Cada llamada usa una "conexión" distinta para no chocar con el límite por IP, que es de memoria
  let ipCounter = 0;
  const ip = () => `10.0.0.${++ipCounter}`;
  const CLIENT = 'cliente-aaaaaaaa';
  const OTHER_CLIENT = 'cliente-bbbbbbbb';

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    tables = new TablesService(prisma);
    qr = new QrService(prisma, tables);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    const tenant = await prisma.tenant.create({
      data: { name: 'Bar A', plan: 'pro', qrEnabled: true, requireOpenRegister: false, logoUrl: null },
    });
    tenantId = tenant.id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Bar B', plan: 'pro', qrEnabled: true } })).id;

    const mk = (tId: string, name: string, token: string) =>
      prisma.table.create({ data: { tenantId: tId, name, qrToken: token, qrPin: '1234' } });
    table1 = await mk(tenantId, 'Mesa 1', 'token-mesa-1-aaaaaaaaaaaaaaaa');
    table2 = await mk(tenantId, 'Mesa 2', 'token-mesa-2-aaaaaaaaaaaaaaaa');
    otherTable = await mk(otherTenantId, 'Mesa B', 'token-mesa-b-aaaaaaaaaaaaaaaa');

    burger = await prisma.menuItem.create({ data: { tenantId, name: 'Hamburguesa', price: 5000 } });
    cola = await prisma.menuItem.create({ data: { tenantId, name: 'Coca', price: 1500 } });
    foreignDish = await prisma.menuItem.create({ data: { tenantId: otherTenantId, name: 'Plato ajeno', price: 1 } });

    sizeGroup = await prisma.modifierGroup.create({
      data: { tenantId, name: 'Tamaño', required: true, selection: 'SINGLE' },
    });
    await prisma.modifierOption.create({ data: { groupId: sizeGroup.id, name: 'Simple', priceDelta: 0 } });
    sizeBig = await prisma.modifierOption.create({ data: { groupId: sizeGroup.id, name: 'Doble', priceDelta: 2000 } });
    await prisma.menuItemModifierGroup.create({ data: { menuItemId: burger.id, groupId: sizeGroup.id, position: 0 } });
  });

  const line = (menuItemId: string, extra: Partial<{ quantity: number; note: string; optionIds: string[] }> = {}) => ({
    menuItemId,
    quantity: 1,
    ...extra,
  });

  // Pedido válido: una gaseosa
  const sendCola = (token = table1.qrToken!, clientId = CLIENT, pin?: string) =>
    qr.createRequest(token, ip(), pin, { clientId, items: [line(cola.id)] });

  // Saca la espera mínima entre envíos para poder enviar varios seguidos
  const skipWait = () =>
    prisma.qrOrderRequest.updateMany({ data: { createdAt: new Date(Date.now() - (MIN_SECONDS_BETWEEN_SENDS + 5) * 1000) } });

  describe('acceso con el código del QR', () => {
    it('muestra la carta del local de esa mesa, con precios y opciones', async () => {
      const info: any = await qr.info(table1.qrToken!, ip(), undefined);
      expect(info.business.name).toBe('Bar A');
      expect(info.table.name).toBe('Mesa 1');
      const names = info.menu.items.map((i: any) => i.name).sort();
      expect(names).toEqual(['Coca', 'Hamburguesa']);
      const hb = info.menu.items.find((i: any) => i.name === 'Hamburguesa');
      expect(hb.groups[0].options.map((o: any) => o.name).sort()).toEqual(['Doble', 'Simple']);
    });

    it('nunca muestra platos de otro negocio ni datos internos', async () => {
      const info: any = await qr.info(table1.qrToken!, ip(), undefined);
      expect(JSON.stringify(info)).not.toContain('Plato ajeno');
      expect(JSON.stringify(info)).not.toContain('Bar B');
      // sin pin de otras mesas, ni códigos, ni ids de negocio
      const text = JSON.stringify(info);
      expect(text).not.toContain('1234');
      expect(text).not.toContain(tenantId);
      expect(text).not.toContain('qrToken');
    });

    it('un código inventado, mal formado, de función apagada o de plan sin QR da el mismo 404', async () => {
      await expect(qr.info('no-existe-no-existe-no-existe', ip(), undefined)).rejects.toThrow(NotFoundException);
      await expect(qr.info('corto', ip(), undefined)).rejects.toThrow(NotFoundException);
      await expect(qr.info("a'; drop table tables;--aaaaaaaaaa", ip(), undefined)).rejects.toThrow(NotFoundException);

      await prisma.tenant.update({ where: { id: tenantId }, data: { qrEnabled: false } });
      await expect(qr.info(table1.qrToken!, ip(), undefined)).rejects.toThrow(NotFoundException);

      await prisma.tenant.update({ where: { id: tenantId }, data: { qrEnabled: true, plan: 'basic' } });
      await expect(qr.info(table1.qrToken!, ip(), undefined)).rejects.toThrow(NotFoundException);
    });
  });

  describe('envío de pedidos', () => {
    it('el pedido queda pendiente en SU mesa, y no crea ninguna orden todavía', async () => {
      const sent: any = await sendCola();
      expect(sent.step).toBe('RECEIVED');

      const stored = await prisma.qrOrderRequest.findMany({});
      expect(stored).toHaveLength(1);
      expect(stored[0].tableId).toBe(table1.id);
      expect(stored[0].tenantId).toBe(tenantId);
      expect(await prisma.order.count({})).toBe(0);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).available).toBe(true);
    });

    it('el precio lo calcula el servidor (plato + opciones) y el cliente no puede mandarlo', async () => {
      const sent: any = await qr.createRequest(table1.qrToken!, ip(), undefined, {
        clientId: CLIENT,
        // aunque el celular agregue "price", el servidor ignora todo lo que no sea id/cantidad/nota/opciones
        items: [{ ...line(burger.id, { quantity: 2, optionIds: [sizeBig.id] }), price: 1 } as any],
      });
      expect(sent.total).toBe(2 * (5000 + 2000));
      expect(sent.items[0]).toMatchObject({ name: 'Hamburguesa', quantity: 2, unitPrice: 7000, extras: ['Doble'] });
    });

    it('rechaza un plato de otro negocio y opciones que el plato no ofrece', async () => {
      await expect(
        qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [line(foreignDish.id)] }),
      ).rejects.toThrow(/carta/);
      // la hamburguesa exige elegir tamaño
      await expect(
        qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [line(burger.id)] }),
      ).rejects.toThrow(/Elegí una opción/);
      await expect(
        qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [line(cola.id, { optionIds: [sizeBig.id] })] }),
      ).rejects.toThrow(/no ofrece/);
      expect(await prisma.qrOrderRequest.count({})).toBe(0);
    });

    it('un código de mesa solo puede enviar a esa mesa: la otra y las de otro negocio no se tocan', async () => {
      await sendCola(table1.qrToken!);
      expect(await prisma.qrOrderRequest.count({ where: { tableId: table2.id } })).toBe(0);
      expect(await prisma.qrOrderRequest.count({ where: { tableId: otherTable.id } })).toBe(0);
      expect(await prisma.qrOrderRequest.count({ where: { tenantId: otherTenantId } })).toBe(0);
    });

    it('límite: como máximo hay pedidos esperando por mesa', async () => {
      for (let i = 0; i < MAX_PENDING_PER_TABLE; i++) {
        await sendCola(table1.qrToken!, `cliente-${i}-aaaaaaaa`);
      }
      await expect(sendCola(table1.qrToken!, 'cliente-nuevo-aaaaaa')).rejects.toThrow(/esperando confirmación/);
      // otra mesa no se ve afectada
      await expect(sendCola(table2.qrToken!)).resolves.toBeDefined();
    });

    it('límite: el mismo celular debe esperar entre envíos', async () => {
      await sendCola();
      await expect(sendCola()).rejects.toThrow(/Esperá unos segundos/);
      await skipWait();
      await expect(sendCola()).resolves.toBeDefined();
    });

    it('rechaza un pedido vacío o enorme', async () => {
      await expect(qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [] })).rejects.toThrow(/vacío/);
      await expect(
        qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [line(cola.id, { quantity: 61 })] }),
      ).rejects.toThrow(/demasiado grande/);
    });

    it('una conexión que dispara demasiados envíos recibe 429', async () => {
      const same = '203.0.113.9';
      let blocked = 0;
      for (let i = 0; i < 20; i++) {
        try {
          await qr.createRequest('no-existe-no-existe-no-existe', same, undefined, { clientId: CLIENT, items: [line(cola.id)] });
        } catch (e: any) {
          if (e.getStatus?.() === 429) blocked++;
        }
      }
      expect(blocked).toBeGreaterThan(0);
    });

    it('sin stock suficiente el pedido no entra (con inventario y "bloquear sin stock")', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { inventoryEnabled: true, blockOutOfStock: true } });
      const stock = await prisma.stockItem.create({ data: { tenantId, name: 'Coca lata', unit: 'unidad', onHand: 1 } });
      await prisma.menuItemIngredient.create({ data: { menuItemId: cola.id, stockItemId: stock.id, quantity: 1 } });

      const info: any = await qr.info(table1.qrToken!, ip(), undefined);
      expect(info.menu.items.find((i: any) => i.name === 'Coca').soldOut).toBe(false);

      await expect(
        qr.createRequest(table1.qrToken!, ip(), undefined, { clientId: CLIENT, items: [line(cola.id, { quantity: 2 })] }),
      ).rejects.toThrow(ConflictException);

      await prisma.stockItem.update({ where: { id: stock.id }, data: { onHand: 0 } });
      const empty: any = await qr.info(table1.qrToken!, ip(), undefined);
      expect(empty.menu.items.find((i: any) => i.name === 'Coca').soldOut).toBe(true);
    });
  });

  describe('código de mesa (opcional)', () => {
    beforeEach(() => prisma.tenant.update({ where: { id: tenantId }, data: { qrRequirePin: true } }));

    it('sin el código no se ve la carta ni se puede pedir', async () => {
      const info: any = await qr.info(table1.qrToken!, ip(), undefined);
      expect(info.pinOk).toBe(false);
      expect(info.requiresPin).toBe(true);
      expect(info.menu).toBeUndefined();
      await expect(sendCola(table1.qrToken!, CLIENT, undefined)).rejects.toThrow(ForbiddenException);
      await expect(sendCola(table1.qrToken!, CLIENT, '0000')).rejects.toThrow(ForbiddenException);
    });

    it('con el código correcto funciona', async () => {
      const info: any = await qr.info(table1.qrToken!, ip(), '1234');
      expect(info.pinOk).toBe(true);
      expect(info.menu.items).toHaveLength(2);
      await expect(sendCola(table1.qrToken!, CLIENT, '1234')).resolves.toBeDefined();
    });

    it('probar códigos al azar se corta después de unos intentos', async () => {
      const same = '198.51.100.7';
      const results: string[] = [];
      for (let i = 0; i < 12; i++) {
        try {
          await qr.info(table2.qrToken!, same, String(1000 + i));
          results.push('ok');
        } catch (e: any) {
          results.push(String(e.getStatus?.()));
        }
      }
      expect(results).toContain('429');
      // ya bloqueado, ni siquiera el código correcto pasa desde esa conexión
      await expect(qr.info(table2.qrToken!, same, '1234')).rejects.toThrow(/Demasiados intentos/);
    });

    it('el código cambia cuando la mesa se libera', async () => {
      await tables.resetTable(tenantId, table1.id);
      const after = await prisma.table.findUniqueOrThrow({ where: { id: table1.id } });
      expect(after.qrPin).toMatch(/^\d{4}$/);
      expect(after.qrPin).not.toBe('');
    });
  });

  describe('mis pedidos', () => {
    it('cada celular ve solo lo suyo', async () => {
      const mine: any = await sendCola(table1.qrToken!, CLIENT);
      await sendCola(table1.qrToken!, OTHER_CLIENT);

      const seen: any = await qr.clientOrders(table1.qrToken!, ip(), undefined, CLIENT);
      expect(seen.requests.map((r: any) => r.id)).toEqual([mine.id]);

      // y desde el QR de otra mesa no aparece nada de esa mesa
      const otherTableSeen: any = await qr.clientOrders(table2.qrToken!, ip(), undefined, CLIENT);
      expect(otherTableSeen.requests).toEqual([]);
    });

    it('puede cancelar su pedido pendiente; el de otro, no', async () => {
      const mine: any = await sendCola(table1.qrToken!, CLIENT);
      await expect(qr.cancelRequest(table1.qrToken!, ip(), undefined, mine.id, OTHER_CLIENT)).rejects.toThrow(ConflictException);
      await expect(qr.cancelRequest(table2.qrToken!, ip(), undefined, mine.id, CLIENT)).rejects.toThrow(ConflictException);
      await expect(qr.cancelRequest(table1.qrToken!, ip(), undefined, mine.id, CLIENT)).resolves.toEqual({ ok: true });
      const seen: any = await qr.clientOrders(table1.qrToken!, ip(), undefined, CLIENT);
      expect(seen.requests[0].step).toBe('CANCELLED');
    });

    it('sigue el avance: recibido → confirmado → en preparación → listo', async () => {
      const sent: any = await sendCola();
      const stepOf = async () => ((await qr.clientOrders(table1.qrToken!, ip(), undefined, CLIENT)) as any).requests[0].step;
      expect(await stepOf()).toBe('RECEIVED');

      await qr.confirm(tenantId, sent.id, { actorName: 'Ana' });
      expect(await stepOf()).toBe('CONFIRMED');

      await prisma.order.updateMany({ data: { status: 'PREPARING' } });
      expect(await stepOf()).toBe('PREPARING');

      await prisma.order.updateMany({ data: { status: 'READY' } });
      expect(await stepOf()).toBe('READY');
    });
  });

  describe('confirmación por el personal', () => {
    it('confirmar crea las órdenes reales, abre la mesa y deja el mozo', async () => {
      const waiter = await prisma.waiter.create({ data: { tenantId, name: 'Luis' } });
      const sent: any = await qr.createRequest(table1.qrToken!, ip(), undefined, {
        clientId: CLIENT,
        items: [line(burger.id, { optionIds: [sizeBig.id], note: 'sin cebolla' }), line(cola.id, { quantity: 2 })],
      });
      await qr.confirm(tenantId, sent.id, { waiterId: waiter.id, actorName: 'Ana' });

      const orders = await prisma.order.findMany({ where: { tableId: table1.id }, orderBy: { createdAt: 'asc' } });
      expect(orders).toHaveLength(2);
      expect(orders.find((o) => o.menuItemId === burger.id)).toMatchObject({ quantity: 1, note: 'sin cebolla', status: 'PENDING' });
      expect(orders.find((o) => o.menuItemId === cola.id)?.quantity).toBe(2);

      const table = await prisma.table.findUniqueOrThrow({ where: { id: table1.id } });
      expect(table.available).toBe(false);
      expect(table.waiterId).toBe(waiter.id);
      expect((await prisma.qrOrderRequest.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('CONFIRMED');
    });

    it('no pisa el mozo que ya tenía la mesa', async () => {
      const w1 = await prisma.waiter.create({ data: { tenantId, name: 'Luis' } });
      const w2 = await prisma.waiter.create({ data: { tenantId, name: 'Eva' } });
      await prisma.table.update({ where: { id: table1.id }, data: { waiterId: w1.id, available: false } });
      const sent: any = await sendCola();
      await qr.confirm(tenantId, sent.id, { waiterId: w2.id, actorName: 'Ana' });
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).waiterId).toBe(w1.id);
    });

    it('confirmar dos veces el mismo pedido no duplica nada', async () => {
      const sent: any = await sendCola();
      const results = await Promise.allSettled([
        qr.confirm(tenantId, sent.id, { actorName: 'Ana' }),
        qr.confirm(tenantId, sent.id, { actorName: 'Beto' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const orders = await prisma.order.findMany({ where: { tableId: table1.id } });
      expect(orders).toHaveLength(1);
      expect(orders[0].quantity).toBe(1);
    });

    it('al confirmar se vuelve a controlar el stock: si no alcanza, el pedido sigue pendiente', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { inventoryEnabled: true, blockOutOfStock: true } });
      const stock = await prisma.stockItem.create({ data: { tenantId, name: 'Coca lata', unit: 'unidad', onHand: 1 } });
      await prisma.menuItemIngredient.create({ data: { menuItemId: cola.id, stockItemId: stock.id, quantity: 1 } });

      const sent: any = await sendCola(); // queda 1 en stock: entra
      await prisma.stockItem.update({ where: { id: stock.id }, data: { onHand: 0 } }); // mientras tanto se vendió

      await expect(qr.confirm(tenantId, sent.id, { actorName: 'Ana' })).rejects.toThrow(ConflictException);
      expect((await prisma.qrOrderRequest.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('PENDING');
      expect(await prisma.order.count({})).toBe(0);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).available).toBe(true);
    });

    it('un plato borrado después del pedido no deja el pedido a medias', async () => {
      const sent: any = await qr.createRequest(table1.qrToken!, ip(), undefined, {
        clientId: CLIENT,
        items: [line(cola.id), line(burger.id, { optionIds: [sizeBig.id] })],
      });
      await prisma.menuItem.delete({ where: { id: burger.id } });
      await expect(qr.confirm(tenantId, sent.id, { actorName: 'Ana' })).rejects.toThrow();
      expect(await prisma.order.count({})).toBe(0);
      expect((await prisma.qrOrderRequest.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('PENDING');
    });

    it('rechazar deja el motivo y el cliente lo ve; no se puede resolver dos veces', async () => {
      const sent: any = await sendCola();
      await qr.reject(tenantId, sent.id, 'Se acabó la gaseosa', 'Ana');
      const seen: any = await qr.clientOrders(table1.qrToken!, ip(), undefined, CLIENT);
      expect(seen.requests[0]).toMatchObject({ step: 'REJECTED', rejectReason: 'Se acabó la gaseosa' });
      await expect(qr.confirm(tenantId, sent.id, { actorName: 'Ana' })).rejects.toThrow(ConflictException);
      await expect(qr.reject(tenantId, sent.id, '', 'Ana')).rejects.toThrow(ConflictException);
    });

    it('otro negocio no puede confirmar, rechazar ni ver los pedidos', async () => {
      const sent: any = await sendCola();
      await expect(qr.confirm(otherTenantId, sent.id, { actorName: 'Intruso' })).rejects.toThrow(NotFoundException);
      await expect(qr.reject(otherTenantId, sent.id, '', 'Intruso')).rejects.toThrow(NotFoundException);
      expect(((await qr.inbox(otherTenantId)) as any).requests).toEqual([]);
      expect(((await qr.inbox(tenantId)) as any).requests).toHaveLength(1);
      expect((await prisma.qrOrderRequest.findUniqueOrThrow({ where: { id: sent.id } })).status).toBe('PENDING');
    });

    it('con confirmación automática el pedido entra solo', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { qrAutoConfirm: true } });
      const sent: any = await sendCola();
      expect(sent.step).toBe('CONFIRMED');
      expect(await prisma.order.count({ where: { tableId: table1.id } })).toBe(1);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).available).toBe(false);
    });
  });

  describe('avisos al mozo', () => {
    it('llamar al mozo no se duplica mientras haya un aviso abierto', async () => {
      await qr.createCall(table1.qrToken!, ip(), undefined, 'WAITER');
      await qr.createCall(table1.qrToken!, ip(), undefined, 'WAITER');
      expect(await prisma.serviceCall.count({ where: { tableId: table1.id } })).toBe(1);

      const inbox: any = await qr.inbox(tenantId);
      expect(inbox.calls).toHaveLength(1);
      expect(inbox.calls[0]).toMatchObject({ tableName: 'Mesa 1', type: 'WAITER' });

      await qr.resolveCall(tenantId, inbox.calls[0].id, 'Ana');
      expect(((await qr.inbox(tenantId)) as any).calls).toEqual([]);
    });

    it('pedir la cuenta exige que la mesa tenga consumos', async () => {
      await expect(qr.createCall(table1.qrToken!, ip(), undefined, 'BILL')).rejects.toThrow(ConflictException);
      const sent: any = await sendCola();
      await qr.confirm(tenantId, sent.id, { actorName: 'Ana' });
      await expect(qr.createCall(table1.qrToken!, ip(), undefined, 'BILL')).resolves.toEqual({ ok: true });
    });

    it('otro negocio no puede cerrar los avisos', async () => {
      await qr.createCall(table1.qrToken!, ip(), undefined, 'WAITER');
      const call = await prisma.serviceCall.findFirstOrThrow({});
      await expect(qr.resolveCall(otherTenantId, call.id, 'Intruso')).rejects.toThrow(NotFoundException);
      expect((await prisma.serviceCall.findUniqueOrThrow({ where: { id: call.id } })).status).toBe('OPEN');
    });
  });

  describe('administración de los QR', () => {
    it('solo el administrador recibe los códigos secretos; el resto solo ve el código de mesa', async () => {
      const asAdmin: any = await qr.tablesView(tenantId, true);
      const asWaiter: any = await qr.tablesView(tenantId, false);
      expect(asAdmin.tables.map((t: any) => t.token).sort()).toEqual([table1.qrToken, table2.qrToken].sort());
      expect(JSON.stringify(asWaiter)).not.toContain('token-mesa');
      expect(asWaiter.tables.every((t: any) => t.token === undefined)).toBe(true);
    });

    it('regenerar invalida el QR impreso y entrega uno nuevo', async () => {
      const old = table1.qrToken!;
      await qr.regenerate(tenantId, table1.id);
      await expect(qr.info(old, ip(), undefined)).rejects.toThrow(NotFoundException);
      const fresh = (await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).qrToken!;
      expect(fresh).not.toBe(old);
      await expect(qr.info(fresh, ip(), undefined)).resolves.toBeDefined();
    });

    it('no se puede regenerar la mesa de otro negocio', async () => {
      await expect(qr.regenerate(otherTenantId, table1.id)).rejects.toThrow(NotFoundException);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).qrToken).toBe('token-mesa-1-aaaaaaaaaaaaaaaa');
    });

    it('generar crea el código de las mesas que no lo tenían y no cambia los existentes', async () => {
      const bare = await prisma.table.create({ data: { tenantId, name: 'Mesa nueva' } });
      const result: any = await qr.generate(tenantId);
      expect(result.created).toBeGreaterThanOrEqual(1);
      const after = await prisma.table.findUniqueOrThrow({ where: { id: bare.id } });
      expect(after.qrToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect((await prisma.table.findUniqueOrThrow({ where: { id: table1.id } })).qrToken).toBe('token-mesa-1-aaaaaaaaaaaaaaaa');
    });

    it('los códigos generados son únicos y largos', async () => {
      await prisma.table.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ tenantId, name: `M${i}` })) });
      await qr.generate(tenantId);
      const tokens = (await prisma.table.findMany({ where: { tenantId } })).map((t) => t.qrToken!);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.every((t) => t.length >= 16)).toBe(true);
    });

    it('un plan sin la función no puede generar ni regenerar', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { plan: 'basic' } });
      await expect(qr.generate(tenantId)).rejects.toThrow(ForbiddenException);
      await expect(qr.regenerate(tenantId, table1.id)).rejects.toThrow(ForbiddenException);
      expect(((await qr.inbox(tenantId)) as any).active).toBe(false);
    });
  });
});
