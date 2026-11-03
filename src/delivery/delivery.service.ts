import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DeliveryOrder, Prisma, Tenant } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature } from '../plans/plans';
import { RateLimiter } from '../qr/rate-limit';
import { QrService } from '../qr/qr.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ModifierSnapshot, modifiersTotal, readSnapshot, resolveModifiers, round2 } from '../modifiers/modifiers.logic';
import {
  StockRequest,
  availableStock,
  committedConsumption,
  consumption,
  deductForSale,
  findShortages,
  hasRecipe,
  loadContext,
  lockStock,
  shortageMessage,
  unitCost,
} from '../inventory/inventory.logic';
import { publicImageUrl } from '../storage/object-storage';
import { PAYMENT_METHODS } from '../sales/sales.service';

// ---- límites: cualquiera con el link puede pedir, así que se frena el abuso por conexión y por teléfono ----
export const MAX_PENDING_PER_PHONE = 3; // pedidos de un mismo teléfono esperando respuesta
const MAX_LINES = 40;
const MAX_UNITS_TOTAL = 80;
const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const TRACK_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UNAVAILABLE = 'Esta tienda no está disponible';

const readLimiter = new RateLimiter(60, 60_000);
const sendLimiter = new RateLimiter(6, 10 * 60_000);

export interface StoredItem {
  menuItemId: string;
  name: string;
  quantity: number;
  note: string;
  optionIds: string[];
  modifiers: ModifierSnapshot[];
  unitPrice: number;
}

export interface CreateOrderInput {
  clientId: string;
  customerName: string;
  phone: string;
  mode: 'pickup' | 'delivery';
  address?: string;
  payMethod: 'cash' | 'transfer';
  note?: string;
  items: { menuItemId: string; quantity: number; note?: string; optionIds?: string[] }[];
}

export interface Actor {
  id: string;
  name: string;
}

const storeActive = (t: Pick<Tenant, 'deliveryEnabled' | 'plan' | 'addons'>) => t.deliveryEnabled && hasFeature(t, 'online_store');

const readItems = (value: unknown): StoredItem[] => (Array.isArray(value) ? (value as StoredItem[]) : []);

const extrasOf = (i: StoredItem) => readSnapshot(i.modifiers).map((m) => m.name);

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qr: QrService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  // =====================================================================================
  //  Cliente (sin sesión): la tienda se identifica por la dirección pública del local
  // =====================================================================================

  // La tienda tiene que existir y estar activa. Si no, siempre el mismo 404: no se distingue "no existe" de "apagada".
  private async resolve(slug: string) {
    const clean = String(slug ?? '').toLowerCase();
    if (!SLUG_RE.test(clean)) throw new NotFoundException(UNAVAILABLE);
    const tenant = await this.prisma.tenant.findUnique({ where: { menuSlug: clean } });
    if (!tenant || !storeActive(tenant)) throw new NotFoundException(UNAVAILABLE);
    return tenant;
  }

  async info(slug: string, ip: string) {
    readLimiter.hit(ip);
    const t = await this.resolve(slug);
    return {
      business: {
        name: t.name,
        logoUrl: t.logoUrl,
        brandColor: t.brandColor,
        currencyCode: t.currencyCode,
        locale: t.locale,
        coverUrl: publicImageUrl(t.coverImageKey),
        backgroundUrl: publicImageUrl(t.backgroundImageKey),
        coverIntensity: t.coverIntensity,
        backgroundIntensity: t.backgroundIntensity,
        address: [t.address, t.city].filter(Boolean).join(', '),
        phone: t.phone,
      },
      store: {
        paused: t.deliveryPaused,
        pickup: t.deliveryPickup,
        home: t.deliveryHome,
        fee: t.deliveryFee,
        payCash: t.deliveryPayCash,
        payTransfer: t.deliveryPayTransfer,
        // Los datos bancarios solo se muestran si el local acepta transferencias
        bankInfo: t.deliveryPayTransfer ? t.deliveryBankInfo : '',
        prepMin: t.deliveryPrepMin,
        // El número de WhatsApp solo se entrega si los pedidos también van por ahí
        whatsapp: t.deliveryDest === 'system' ? '' : t.deliveryWhatsapp,
        // true = el pedido no se guarda en el sistema: solo se arma el mensaje de WhatsApp
        whatsappOnly: t.deliveryDest === 'whatsapp',
      },
      menu: await this.qr.publicMenu(t),
    };
  }

  /**
   * Arma las líneas del pedido con los precios del servidor: del celular solo llegan ids, cantidades y aclaraciones.
   * Es la única fuente de precios, tanto para guardar el pedido como para el mensaje de WhatsApp.
   */
  private async price(db: Prisma.TransactionClient | PrismaService, tenant: Tenant, input: CreateOrderInput) {
    if (input.mode === 'pickup' && !tenant.deliveryPickup) throw new BadRequestException('Este local no ofrece retiro en el local');
    if (input.mode === 'delivery' && !tenant.deliveryHome) throw new BadRequestException('Este local no ofrece envío a domicilio');
    if (input.payMethod === 'cash' && !tenant.deliveryPayCash) throw new BadRequestException('Este local no acepta efectivo');
    if (input.payMethod === 'transfer' && !tenant.deliveryPayTransfer) throw new BadRequestException('Este local no acepta transferencias');
    if (input.mode === 'delivery' && (input.address ?? '').trim().length < 4) {
      throw new BadRequestException('Escribí la dirección de entrega');
    }

    const totalUnits = input.items.reduce((sum, i) => sum + i.quantity, 0);
    if (input.items.length === 0) throw new BadRequestException('El pedido está vacío');
    if (input.items.length > MAX_LINES || totalUnits > MAX_UNITS_TOTAL) {
      throw new BadRequestException('El pedido es demasiado grande. Para pedidos grandes, comunicate con el local.');
    }

    const stored: StoredItem[] = [];
    for (const line of input.items) {
      const menuItem = await db.menuItem.findFirst({ where: { id: line.menuItemId, tenantId: tenant.id, visibleInMenu: true } });
      if (!menuItem) throw new BadRequestException('Un producto del pedido ya no está en la carta. Actualizá la página.');
      const modifiers = await resolveModifiers(db, tenant.id, menuItem.id, menuItem.name, line.optionIds ?? []);
      stored.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        quantity: line.quantity,
        note: (line.note ?? '').trim(),
        optionIds: modifiers.map((m) => m.optionId),
        modifiers,
        unitPrice: round2(menuItem.price + modifiersTotal(modifiers)),
      });
    }

    // Con inventario y "bloquear pedidos sin stock", lo que no se puede preparar no se puede pedir
    if (tenant.inventoryEnabled && hasFeature(tenant, 'inventory') && tenant.blockOutOfStock) {
      const ctx = await loadContext(db, tenant.id);
      const avail = availableStock(ctx, await committedConsumption(db, tenant.id, ctx));
      const shortages = findShortages(
        ctx,
        avail,
        stored.map((s) => ({ menuItemId: s.menuItemId, quantity: s.quantity, optionIds: s.optionIds })),
      );
      if (shortages.length) throw new ConflictException(shortageMessage(shortages));
    }

    const subtotal = round2(stored.reduce((sum, s) => sum + s.unitPrice * s.quantity, 0));
    const deliveryFee = input.mode === 'delivery' ? round2(tenant.deliveryFee) : 0;
    return { stored, subtotal, deliveryFee, total: round2(subtotal + deliveryFee) };
  }

  async create(slug: string, ip: string, input: CreateOrderInput) {
    sendLimiter.hit(ip, 'Estás enviando demasiados pedidos, esperá un momento');
    const tenant = await this.resolve(slug);
    if (tenant.deliveryPaused) throw new ConflictException('La tienda no está recibiendo pedidos en este momento');
    const phone = input.phone.replace(/[^\d+]/g, '');

    // Solo WhatsApp: no se guarda nada; se devuelve el pedido ya con los precios del servidor para armar el mensaje
    if (tenant.deliveryDest === 'whatsapp') {
      const priced = await this.price(this.prisma, tenant, input);
      return { stored: false, order: this.view({ ...input, phone, address: (input.address ?? '').trim(), note: (input.note ?? '').trim(), ...priced, items: priced.stored }, tenant) };
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // El local se bloquea un instante: dos pedidos a la vez no se saltean los límites ni repiten el número
      await tx.$queryRaw`SELECT id FROM "tenants" WHERE id = ${tenant.id} FOR UPDATE`;

      const pending = await tx.deliveryOrder.count({ where: { tenantId: tenant.id, phone, status: 'PENDING' } });
      if (pending >= MAX_PENDING_PER_PHONE) {
        throw new HttpException('Ya tenés pedidos esperando respuesta del local. Cuando los acepte, podés pedir más.', HttpStatus.TOO_MANY_REQUESTS);
      }

      const priced = await this.price(tx, tenant, input);
      const last = await tx.deliveryOrder.aggregate({ where: { tenantId: tenant.id }, _max: { number: true } });
      return tx.deliveryOrder.create({
        data: {
          tenantId: tenant.id,
          number: (last._max.number ?? 0) + 1,
          trackToken: randomBytes(18).toString('base64url'),
          clientId: input.clientId,
          customerName: input.customerName.trim(),
          phone,
          mode: input.mode,
          address: input.mode === 'delivery' ? (input.address ?? '').trim() : '',
          payMethod: input.payMethod,
          note: (input.note ?? '').trim(),
          items: priced.stored as unknown as Prisma.InputJsonValue,
          subtotal: priced.subtotal,
          deliveryFee: priced.deliveryFee,
          total: priced.total,
        },
      });
    });

    this.realtime?.notifyTenant(tenant.id, ['delivery']);
    return { stored: true, order: this.view(created, tenant) };
  }

  // Cómo va un pedido, para quien lo hizo (se llega con el código secreto del pedido)
  async track(slug: string, ip: string, token: string) {
    readLimiter.hit(ip);
    const tenant = await this.resolve(slug);
    if (!TRACK_RE.test(token ?? '')) throw new NotFoundException('Pedido no encontrado');
    const order = await this.prisma.deliveryOrder.findFirst({ where: { trackToken: token, tenantId: tenant.id } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    return this.view(order, tenant);
  }

  async cancelByClient(slug: string, ip: string, token: string) {
    readLimiter.hit(ip);
    const tenant = await this.resolve(slug);
    if (!TRACK_RE.test(token ?? '')) throw new NotFoundException('Pedido no encontrado');
    const { count } = await this.prisma.deliveryOrder.updateMany({
      where: { trackToken: token, tenantId: tenant.id, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedAt: new Date(), resolvedBy: 'cliente' },
    });
    if (count === 0) throw new ConflictException('Ese pedido ya no se puede cancelar');
    this.realtime?.notifyTenant(tenant.id, ['delivery']);
    return { ok: true };
  }

  // Lo que ve el cliente de su pedido. Nunca incluye datos de otros pedidos ni del sistema.
  private view(
    o: {
      number?: number | null;
      trackToken?: string;
      status?: string;
      rejectReason?: string;
      createdAt?: Date;
      customerName: string;
      phone: string;
      mode: string;
      address?: string;
      payMethod: string;
      note?: string;
      items: unknown;
      subtotal: number;
      deliveryFee: number;
      total: number;
    },
    tenant: Tenant,
  ) {
    return {
      number: o.number ?? null,
      token: o.trackToken ?? null,
      status: o.status ?? 'PENDING',
      rejectReason: o.rejectReason ?? '',
      createdAt: o.createdAt ?? new Date(),
      customerName: o.customerName,
      phone: o.phone,
      mode: o.mode,
      address: o.address ?? '',
      payMethod: o.payMethod,
      note: o.note ?? '',
      subtotal: o.subtotal,
      deliveryFee: o.deliveryFee,
      total: o.total,
      prepMin: tenant.deliveryPrepMin,
      bankInfo: o.payMethod === 'transfer' ? tenant.deliveryBankInfo : '',
      items: readItems(o.items).map((i) => ({ name: i.name, quantity: i.quantity, note: i.note, extras: extrasOf(i), unitPrice: i.unitPrice })),
    };
  }

  // =====================================================================================
  //  Personal (con sesión): bandeja de pedidos de la tienda
  // =====================================================================================

  async list(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!storeActive(tenant)) return { active: false, orders: [] };
    const now = Date.now();
    const orders = await this.prisma.deliveryOrder.findMany({
      where: {
        tenantId,
        OR: [
          { status: { in: ['PENDING', 'ACCEPTED', 'READY'] }, createdAt: { gte: new Date(now - 72 * 3600_000) } },
          { status: { in: ['COMPLETED', 'REJECTED', 'CANCELLED'] }, createdAt: { gte: new Date(now - 12 * 3600_000) } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return {
      active: true,
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        createdAt: o.createdAt,
        customerName: o.customerName,
        phone: o.phone,
        mode: o.mode,
        address: o.address,
        payMethod: o.payMethod,
        note: o.note,
        subtotal: o.subtotal,
        deliveryFee: o.deliveryFee,
        total: o.total,
        rejectReason: o.rejectReason,
        items: readItems(o.items).map((i) => ({ name: i.name, quantity: i.quantity, note: i.note, extras: extrasOf(i), unitPrice: i.unitPrice })),
      })),
    };
  }

  private async move(tenantId: string, id: string, from: DeliveryOrder['status'][], data: Prisma.DeliveryOrderUpdateManyMutationInput) {
    const { count } = await this.prisma.deliveryOrder.updateMany({ where: { id, tenantId, status: { in: from } }, data });
    if (count === 0) {
      const exists = await this.prisma.deliveryOrder.count({ where: { id, tenantId } });
      if (!exists) throw new NotFoundException('Pedido no encontrado');
      throw new ConflictException('Este pedido ya cambió de estado. Actualizá la bandeja.');
    }
    this.realtime?.notifyTenant(tenantId, ['delivery']);
    return { ok: true };
  }

  accept(tenantId: string, id: string) {
    return this.move(tenantId, id, ['PENDING'], { status: 'ACCEPTED' });
  }

  ready(tenantId: string, id: string) {
    return this.move(tenantId, id, ['ACCEPTED'], { status: 'READY' });
  }

  reject(tenantId: string, id: string, reason: string, actor: Actor) {
    return this.move(tenantId, id, ['PENDING', 'ACCEPTED', 'READY'], {
      status: 'REJECTED',
      rejectReason: reason.trim(),
      resolvedAt: new Date(),
      resolvedBy: actor.name,
    });
  }

  /**
   * Entrega y cobro: el pedido pasa a ser una venta (del Mostrador, para llevar) con sus pagos, y con inventario descuenta
   * los insumos. Todo en una transacción; el id de cobro `delivery-<pedido>` impide registrar dos veces el mismo pedido.
   */
  async complete(tenantId: string, id: string, actor: Actor, paymentMethod?: string) {
    const order = await this.prisma.deliveryOrder.findFirst({ where: { id, tenantId } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (order.status === 'COMPLETED') return { ok: true, saleId: order.saleId };
    if (order.status !== 'ACCEPTED' && order.status !== 'READY') {
      throw new ConflictException(order.status === 'PENDING' ? 'Aceptá el pedido antes de entregarlo' : 'Este pedido ya no se puede entregar');
    }

    const method = paymentMethod ?? (order.payMethod === 'transfer' ? 'transferencia' : 'efectivo');
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) throw new BadRequestException('Método de pago no válido');

    const items = readItems(order.items);
    const menu = await this.prisma.menuItem.findMany({ where: { tenantId, id: { in: items.map((i) => i.menuItemId) } }, select: { id: true, isPromo: true } });
    const promo = new Map(menu.map((m) => [m.id, m.isPromo]));

    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const inventory = tenant.inventoryEnabled ? await loadContext(this.prisma, tenantId) : null;
    const charged: StockRequest[] = [];
    const lines: Prisma.SaleItemCreateWithoutSaleInput[] = items.map((i) => {
      let cost: number | null = null;
      if (inventory) {
        if (hasRecipe(inventory, i.menuItemId)) cost = unitCost(inventory, consumption(inventory, i.menuItemId, i.optionIds));
        charged.push({ menuItemId: i.menuItemId, quantity: i.quantity, optionIds: i.optionIds });
      }
      return {
        name: i.name,
        unitPrice: i.unitPrice,
        quantity: i.quantity,
        note: i.note,
        isPromo: promo.get(i.menuItemId) ?? false,
        discountPct: 0,
        lineTotal: round2(i.unitPrice * i.quantity),
        unitCost: cost,
        modifiers: readSnapshot(i.modifiers) as unknown as Prisma.InputJsonValue,
      };
    });
    // El envío es ingreso del local: va como un renglón más (sin descuento)
    if (order.deliveryFee > 0) {
      lines.push({
        name: 'Envío a domicilio',
        unitPrice: order.deliveryFee,
        quantity: 1,
        note: '',
        isPromo: true,
        discountPct: 0,
        lineTotal: order.deliveryFee,
        unitCost: null,
        modifiers: [] as Prisma.InputJsonValue,
      });
    }

    const saleId = await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (fresh.requireOpenRegister && !fresh.openRegisterId) {
        throw new ConflictException('No hay caja abierta. Abrí la caja para cobrar.');
      }

      const claimed = await tx.deliveryOrder.updateMany({
        where: { id, tenantId, status: { in: ['ACCEPTED', 'READY'] } },
        data: { status: 'COMPLETED', resolvedAt: new Date(), resolvedBy: actor.name },
      });
      if (claimed.count === 0) throw new ConflictException('Este pedido ya fue resuelto por otra persona');

      if (inventory) {
        await lockStock(tx, tenantId);
        const ctx = await loadContext(tx, tenantId);
        const avail = availableStock(ctx, await committedConsumption(tx, tenantId, ctx));
        const shortages = findShortages(ctx, avail, charged);
        if (shortages.length) throw new ConflictException(shortageMessage(shortages));
      }

      const total = round2(order.total);
      const sale = await tx.sale.create({
        data: {
          tenantId,
          checkoutId: `delivery-${order.id}`,
          source: 'mostrador',
          takeaway: true,
          tableName: 'Tienda online',
          waiterName: '',
          cashierName: actor.name,
          paymentMethod: method,
          grossTotal: total,
          discountTotal: 0,
          globalDiscountPct: 0,
          totalAmount: total,
          tipAmount: 0,
          commissionPct: 0,
          registerId: fresh.openRegisterId,
          items: { create: lines },
          payments: { create: total > 0 ? [{ method, amount: total, tendered: null, change: 0 }] : [] },
        },
      });
      await tx.deliveryOrder.update({ where: { id }, data: { saleId: sale.id } });
      if (inventory) await deductForSale(tx, tenantId, inventory, charged, sale.id, actor.name);
      return sale.id;
    });

    this.realtime?.notifyTenant(tenantId, ['delivery']);
    return { ok: true, saleId };
  }
}
