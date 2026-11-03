import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { DeliveryService, CreateOrderInput, MAX_PENDING_PER_PHONE } from './delivery.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Tienda online (/delivery)', () => {
  let prisma: PrismaService;
  let delivery: DeliveryService;
  let tenantId: string;
  let cafeId: string;
  let medialunaId: string;
  const SLUG = 'cafe-prueba';
  const actor = { id: 'u1', name: 'Caro' };

  let n = 0;
  let ipN = 0;
  // Una conexión distinta por prueba: el límite por conexión no debe cruzarse entre pruebas
  const ip = () => `10.1.0.${++ipN}`;

  const order = (over: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
    clientId: `client-${++n}-abcdefgh`,
    customerName: 'Marta',
    phone: `11 5555-${String(1000 + n)}`,
    mode: 'pickup',
    payMethod: 'cash',
    items: [{ menuItemId: cafeId, quantity: 2 }],
    ...over,
  });

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    delivery = new DeliveryService(prisma, new QrService(prisma, {} as any));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (
      await prisma.tenant.create({
        data: { name: 'Café Prueba', plan: 'takeaway', requireOpenRegister: false, menuSlug: SLUG, deliveryEnabled: true, deliveryPrepMin: 25 },
      })
    ).id;
    cafeId = (await prisma.menuItem.create({ data: { tenantId, name: 'Café', price: 2800 } })).id;
    medialunaId = (await prisma.menuItem.create({ data: { tenantId, name: 'Medialuna', price: 1500 } })).id;
  });

  it('muestra la tienda con la carta y la configuración, sin datos bancarios si no acepta transferencias', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryBankInfo: 'alias.secreto', deliveryWhatsapp: '5491122334455' } });
    const info = await delivery.info(SLUG, ip());
    expect(info.business.name).toBe('Café Prueba');
    expect(info.menu.items.map((i) => i.name).sort()).toEqual(['Café', 'Medialuna']);
    expect(info.store.bankInfo).toBe('');
    expect(info.store.whatsapp).toBe(''); // los pedidos van solo al sistema: el número no se entrega
    expect(info.store.prepMin).toBe(25);
  });

  it('no existe si está apagada, si el plan no la incluye o si el nombre es inventado', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryEnabled: false } });
    await expect(delivery.info(SLUG, ip())).rejects.toBeInstanceOf(NotFoundException);
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryEnabled: true, plan: 'basic' } });
    await expect(delivery.info(SLUG, ip())).rejects.toBeInstanceOf(NotFoundException);
    await expect(delivery.info('../etc', ip())).rejects.toBeInstanceOf(NotFoundException);
    await expect(delivery.info('no-existe', ip())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el servidor calcula el total: retiro sin costo de envío y numera los pedidos', async () => {
    const first = await delivery.create(SLUG, ip(), order());
    const second = await delivery.create(SLUG, ip(), order({ items: [{ menuItemId: medialunaId, quantity: 1 }] }));
    expect(first.stored).toBe(true);
    expect(first.order.total).toBe(5600);
    expect(first.order.deliveryFee).toBe(0);
    expect(first.order.number).toBe(1);
    expect(second.order.number).toBe(2);
    expect(first.order.token).toBeTruthy();
  });

  it('con envío suma el costo fijo y exige dirección', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryHome: true, deliveryFee: 900 } });
    await expect(delivery.create(SLUG, ip(), order({ mode: 'delivery' }))).rejects.toBeInstanceOf(BadRequestException);
    const done = await delivery.create(SLUG, ip(), order({ mode: 'delivery', address: 'Calle Falsa 123' }));
    expect(done.order.subtotal).toBe(5600);
    expect(done.order.deliveryFee).toBe(900);
    expect(done.order.total).toBe(6500);
    expect(done.order.address).toBe('Calle Falsa 123');
  });

  it('rechaza formas de entrega o de pago que el local no ofrece', async () => {
    // el local no hace envíos ni acepta transferencias
    await expect(delivery.create(SLUG, ip(), order({ mode: 'delivery', address: 'Calle 1234' }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(delivery.create(SLUG, ip(), order({ payMethod: 'transfer' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('con transferencia, el cliente recibe los datos bancarios en su pedido', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryPayTransfer: true, deliveryBankInfo: 'Alias: cafe.prueba' } });
    const done = await delivery.create(SLUG, ip(), order({ payMethod: 'transfer' }));
    expect(done.order.bankInfo).toBe('Alias: cafe.prueba');
    const cash = await delivery.create(SLUG, ip(), order({ payMethod: 'cash' }));
    expect(cash.order.bankInfo).toBe('');
  });

  it('los precios no se pueden alterar desde el celular y los productos ocultos no se piden', async () => {
    const forged = { ...order(), items: [{ menuItemId: cafeId, quantity: 1, price: 1 } as any] };
    const done = await delivery.create(SLUG, ip(), forged);
    expect(done.order.total).toBe(2800);

    await prisma.menuItem.update({ where: { id: cafeId }, data: { visibleInMenu: false } });
    await expect(delivery.create(SLUG, ip(), order())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un producto de otro local no se puede pedir', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Otro' } });
    const foreign = await prisma.menuItem.create({ data: { tenantId: other.id, name: 'Ajeno', price: 1 } });
    await expect(delivery.create(SLUG, ip(), order({ items: [{ menuItemId: foreign.id, quantity: 1 }] }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('en pausa no recibe pedidos', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryPaused: true } });
    await expect(delivery.create(SLUG, ip(), order())).rejects.toBeInstanceOf(ConflictException);
  });

  it('un mismo teléfono no puede acumular pedidos sin respuesta', async () => {
    const phone = '11 4444-0000';
    for (let i = 0; i < MAX_PENDING_PER_PHONE; i++) await delivery.create(SLUG, ip(), order({ phone }));
    await expect(delivery.create(SLUG, ip(), order({ phone }))).rejects.toMatchObject({ status: 429 });
  });

  it('solo WhatsApp: calcula el pedido pero no lo guarda', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryDest: 'whatsapp', deliveryWhatsapp: '5491122334455' } });
    const info = await delivery.info(SLUG, ip());
    expect(info.store.whatsappOnly).toBe(true);
    expect(info.store.whatsapp).toBe('5491122334455');
    const done = await delivery.create(SLUG, ip(), order());
    expect(done.stored).toBe(false);
    expect(done.order.total).toBe(5600);
    expect(await prisma.deliveryOrder.count({ where: { tenantId } })).toBe(0);
  });

  it('el cliente sigue su pedido con su código y solo puede cancelarlo mientras está pendiente', async () => {
    const done = await delivery.create(SLUG, ip(), order());
    const token = done.order.token as string;
    expect((await delivery.track(SLUG, ip(), token)).status).toBe('PENDING');
    await expect(delivery.track(SLUG, ip(), 'x'.repeat(24))).rejects.toBeInstanceOf(NotFoundException);

    await delivery.cancelByClient(SLUG, ip(), token);
    expect((await delivery.track(SLUG, ip(), token)).status).toBe('CANCELLED');
    await expect(delivery.cancelByClient(SLUG, ip(), token)).rejects.toBeInstanceOf(ConflictException);
  });

  it('el código de un pedido no sirve en la tienda de otro local', async () => {
    const done = await delivery.create(SLUG, ip(), order());
    await prisma.tenant.create({ data: { name: 'B', plan: 'takeaway', menuSlug: 'otro-local', deliveryEnabled: true } });
    await expect(delivery.track('otro-local', ip(), done.order.token as string)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la bandeja sigue el recorrido: aceptar, listo y entregar crea la venta', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryHome: true, deliveryFee: 900 } });
    const done = await delivery.create(SLUG, ip(), order({ mode: 'delivery', address: 'Calle Falsa 123' }));
    const id = (await delivery.list(tenantId)).orders[0].id;

    // no se entrega sin aceptar
    await expect(delivery.complete(tenantId, id, actor)).rejects.toBeInstanceOf(ConflictException);
    await delivery.accept(tenantId, id);
    await expect(delivery.accept(tenantId, id)).rejects.toBeInstanceOf(ConflictException);
    await delivery.ready(tenantId, id);
    expect((await delivery.track(SLUG, ip(), done.order.token as string)).status).toBe('READY');

    const result = await delivery.complete(tenantId, id, actor);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: result.saleId as string }, include: { items: true, payments: true } });
    expect(sale.totalAmount).toBe(6500);
    expect(sale.source).toBe('mostrador');
    expect(sale.takeaway).toBe(true);
    expect(sale.paymentMethod).toBe('efectivo');
    expect(sale.items.map((i) => i.name).sort()).toEqual(['Café', 'Envío a domicilio']);
    expect(sale.payments).toHaveLength(1);
    expect(sale.payments[0].amount).toBe(6500);
  });

  it('entregar dos veces el mismo pedido no duplica la venta', async () => {
    await delivery.create(SLUG, ip(), order());
    const id = (await delivery.list(tenantId)).orders[0].id;
    await delivery.accept(tenantId, id);
    const a = await delivery.complete(tenantId, id, actor);
    const b = await delivery.complete(tenantId, id, actor);
    expect(b.saleId).toBe(a.saleId);
    expect(await prisma.sale.count({ where: { tenantId } })).toBe(1);
  });

  it('cobra por transferencia cuando el cliente la eligió, o por el método que indique el local', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { deliveryPayTransfer: true, deliveryBankInfo: 'alias' } });
    await delivery.create(SLUG, ip(), order({ payMethod: 'transfer' }));
    await delivery.create(SLUG, ip(), order());
    const [one, two] = (await delivery.list(tenantId)).orders;
    await delivery.accept(tenantId, one.id);
    await delivery.accept(tenantId, two.id);
    const a = await delivery.complete(tenantId, one.id, actor);
    const b = await delivery.complete(tenantId, two.id, actor, 'tarjeta');
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: a.saleId as string } })).paymentMethod).toBe('transferencia');
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: b.saleId as string } })).paymentMethod).toBe('tarjeta');
  });

  it('no se entrega sin caja abierta si el local la exige', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { requireOpenRegister: true } });
    await delivery.create(SLUG, ip(), order());
    const id = (await delivery.list(tenantId)).orders[0].id;
    await delivery.accept(tenantId, id);
    await expect(delivery.complete(tenantId, id, actor)).rejects.toBeInstanceOf(ConflictException);
    // y el pedido sigue pendiente de entregar
    expect((await delivery.list(tenantId)).orders[0].status).toBe('ACCEPTED');
  });

  it('rechazar guarda el motivo, que ve el cliente', async () => {
    const done = await delivery.create(SLUG, ip(), order());
    const id = (await delivery.list(tenantId)).orders[0].id;
    await delivery.reject(tenantId, id, ' Sin stock ', actor);
    const view = await delivery.track(SLUG, ip(), done.order.token as string);
    expect(view.status).toBe('REJECTED');
    expect(view.rejectReason).toBe('Sin stock');
    await expect(delivery.accept(tenantId, id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('un local no puede ver ni tocar los pedidos de otro', async () => {
    await delivery.create(SLUG, ip(), order());
    const id = (await delivery.list(tenantId)).orders[0].id;
    const other = await prisma.tenant.create({ data: { name: 'B', plan: 'takeaway', deliveryEnabled: true } });
    expect((await delivery.list(other.id)).orders).toHaveLength(0);
    await expect(delivery.accept(other.id, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(delivery.complete(other.id, id, actor)).rejects.toBeInstanceOf(NotFoundException);
  });
});
