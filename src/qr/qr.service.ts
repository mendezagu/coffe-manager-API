import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, QrOrderRequest, Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hasFeature, FEATURE_LABELS } from '../plans/plans';
import { TablesService } from '../tables/tables.service';
import { ModifierSnapshot, modifiersTotal, readSnapshot, resolveModifiers, round2 } from '../modifiers/modifiers.logic';
import { availableStock, committedConsumption, loadContext, maxUnits } from '../inventory/inventory.logic';
import { newQrToken, newTablePin, samePin } from './qr.tokens';
import { RateLimiter } from './rate-limit';

// ---- límites (pensados para un local con una mesa por QR y clientes que no se conocen) ----
export const MAX_PENDING_PER_TABLE = 3; // pedidos esperando confirmación en una misma mesa
export const MIN_SECONDS_BETWEEN_SENDS = 20; // espera entre dos envíos del mismo celular
const MAX_LINES = 30;
const MAX_UNITS_TOTAL = 60;
const VISIBLE_HOURS = 12; // el cliente ve sus pedidos de las últimas horas
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const UNAVAILABLE = 'Este código QR no está disponible';

const ipLimiter = new RateLimiter(40, 60_000); // lecturas y envíos por conexión
const sendLimiter = new RateLimiter(12, 60_000); // envíos de pedidos por conexión
const callLimiter = new RateLimiter(6, 10 * 60_000); // avisos al mozo por conexión
const pinFailsByClient = new RateLimiter(8, 10 * 60_000);
const pinFailsByToken = new RateLimiter(40, 10 * 60_000);

export interface StoredItem {
  menuItemId: string;
  name: string;
  quantity: number;
  note: string;
  optionIds: string[];
  modifiers: ModifierSnapshot[];
  unitPrice: number;
}

export interface CreateRequestInput {
  clientId: string;
  customerName?: string;
  items: { menuItemId: string; quantity: number; note?: string; optionIds?: string[] }[];
}

const qrActive = (t: Pick<Tenant, 'qrEnabled' | 'plan'>) => t.qrEnabled && hasFeature(t.plan, 'qr_ordering');

function readItems(value: unknown): StoredItem[] {
  return Array.isArray(value) ? (value as StoredItem[]) : [];
}

@Injectable()
export class QrService {
  constructor(private readonly prisma: PrismaService, private readonly tables: TablesService) {}

  // =====================================================================================
  //  Cliente (sin sesión): todo se identifica por el código secreto del QR de la mesa
  // =====================================================================================

  // El código tiene que existir y el negocio tener el pedido por QR activo. Si no, es siempre el mismo
  // 404: no se distingue "código inexistente" de "función apagada".
  private async resolve(token: string) {
    if (!TOKEN_RE.test(token ?? '')) throw new NotFoundException(UNAVAILABLE);
    const table = await this.prisma.table.findUnique({ where: { qrToken: token }, include: { tenant: true } });
    if (!table || !qrActive(table.tenant)) throw new NotFoundException(UNAVAILABLE);
    return { table, tenant: table.tenant };
  }

  // true = no hace falta código o es correcto. Los intentos fallidos se limitan (por celular y por mesa).
  private async checkPin(ctx: { table: { id: string; qrPin: string }; tenant: Tenant }, token: string, ip: string, pin: unknown) {
    if (!ctx.tenant.qrRequirePin) return true;
    if (!ctx.table.qrPin) {
      ctx.table.qrPin = newTablePin();
      await this.prisma.table.update({ where: { id: ctx.table.id }, data: { qrPin: ctx.table.qrPin } });
    }
    const clientKey = `${ip}|${token}`;
    if (pinFailsByClient.isBlocked(clientKey) || pinFailsByToken.isBlocked(token)) {
      throw new HttpException('Demasiados intentos con el código de mesa. Pedíselo al mozo.', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (samePin(ctx.table.qrPin, pin)) return true;
    if (typeof pin === 'string' && pin.trim() !== '') {
      pinFailsByClient.hit(clientKey);
      pinFailsByToken.hit(token);
    }
    return false;
  }

  private async resolveWithPin(token: string, ip: string, pin: unknown) {
    ipLimiter.hit(ip);
    const ctx = await this.resolve(token);
    if (!(await this.checkPin(ctx, token, ip, pin))) {
      throw new ForbiddenException({ message: 'Ingresá el código de mesa', code: 'PIN_REQUIRED' });
    }
    return ctx;
  }

  // Lo que ve el cliente al abrir el QR: datos del local, el nombre de su mesa y la carta.
  async info(token: string, ip: string, pin: unknown) {
    ipLimiter.hit(ip);
    const ctx = await this.resolve(token);
    const { table, tenant } = ctx;
    const business = { name: tenant.name, logoUrl: tenant.logoUrl, currencyCode: tenant.currencyCode, locale: tenant.locale };
    const base = {
      business,
      table: { name: table.name },
      requiresPin: tenant.qrRequirePin,
      autoConfirm: tenant.qrAutoConfirm,
      // Sin cocina no hay "en preparación" ni "listo": el pedido termina cuando el mozo lo confirma
      kitchen: tenant.kitchenEnabled,
      limits: { maxPending: MAX_PENDING_PER_TABLE, minSecondsBetweenSends: MIN_SECONDS_BETWEEN_SENDS },
    };
    if (!(await this.checkPin(ctx, token, ip, pin))) return { ...base, pinOk: false };
    return { ...base, pinOk: true, menu: await this.publicMenu(tenant) };
  }

  // La carta pública: solo nombre, precio y opciones. Sin costos, recetas ni existencias exactas.
  private async publicMenu(tenant: Tenant) {
    const [categories, items] = await Promise.all([
      this.prisma.category.findMany({ where: { tenantId: tenant.id }, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
      this.prisma.menuItem.findMany({
        where: { tenantId: tenant.id },
        orderBy: { name: 'asc' },
        include: {
          modifierGroups: {
            orderBy: { position: 'asc' },
            include: { group: { include: { options: { where: { active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] } } } },
          },
        },
      }),
    ]);

    // Con inventario y "bloquear pedidos sin stock", lo que no se puede preparar sale como "Agotado"
    let soldOut: (id: string) => boolean = () => false;
    if (tenant.inventoryEnabled && hasFeature(tenant.plan, 'inventory') && tenant.blockOutOfStock) {
      const ctx = await loadContext(this.prisma, tenant.id);
      const avail = availableStock(ctx, await committedConsumption(this.prisma, tenant.id, ctx));
      soldOut = (id) => {
        const units = maxUnits(ctx, avail, id);
        return units !== null && units <= 0;
      };
    }

    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        price: i.price,
        categoryId: i.categoryId,
        isPromo: i.isPromo,
        soldOut: soldOut(i.id),
        groups: i.modifierGroups
          .map((l) => l.group)
          .filter((g) => g.options.length > 0)
          .map((g) => ({
            id: g.id,
            name: g.name,
            selection: g.selection,
            required: g.required,
            options: g.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta })),
          })),
      })),
    };
  }

  async createRequest(token: string, ip: string, pin: unknown, input: CreateRequestInput) {
    sendLimiter.hit(ip, 'Estás enviando demasiados pedidos, esperá un momento');
    const { table, tenant } = await this.resolveWithPin(token, ip, pin);
    if (table.controlledById) throw new ConflictException('Esta mesa está unida a otra: pedile al mozo');

    const totalUnits = input.items.reduce((sum, i) => sum + i.quantity, 0);
    if (input.items.length === 0) throw new BadRequestException('El pedido está vacío');
    if (input.items.length > MAX_LINES || totalUnits > MAX_UNITS_TOTAL) {
      throw new BadRequestException('El pedido es demasiado grande. Para pedidos grandes, hablá con el mozo.');
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // La mesa se bloquea un instante: dos celulares enviando a la vez no se saltean los límites
      await tx.$queryRaw`SELECT id FROM "tables" WHERE id = ${table.id} FOR UPDATE`;

      const pending = await tx.qrOrderRequest.count({ where: { tableId: table.id, status: 'PENDING' } });
      if (pending >= MAX_PENDING_PER_TABLE) {
        throw new HttpException(
          'Ya hay pedidos de esta mesa esperando confirmación. Cuando el mozo los confirme, podés pedir más.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const last = await tx.qrOrderRequest.findFirst({
        where: { tableId: table.id, clientId: input.clientId },
        orderBy: { createdAt: 'desc' },
      });
      if (last && Date.now() - last.createdAt.getTime() < MIN_SECONDS_BETWEEN_SENDS * 1000) {
        throw new HttpException('Esperá unos segundos antes de enviar otro pedido', HttpStatus.TOO_MANY_REQUESTS);
      }

      // El precio lo decide el servidor: del celular solo llegan ids, cantidades y aclaraciones
      const stored: StoredItem[] = [];
      for (const line of input.items) {
        const menuItem = await tx.menuItem.findFirst({ where: { id: line.menuItemId, tenantId: tenant.id } });
        if (!menuItem) throw new BadRequestException('Un plato del pedido ya no está en la carta. Actualizá la página.');
        const modifiers = await resolveModifiers(tx, tenant.id, menuItem.id, menuItem.name, line.optionIds ?? []);
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

      // Aviso temprano si no alcanza el stock (al confirmar se vuelve a comprobar)
      await this.tables.assertStock(
        tx,
        tenant.id,
        stored.map((s) => ({ menuItemId: s.menuItemId, quantity: s.quantity, optionIds: s.optionIds })),
      );

      return tx.qrOrderRequest.create({
        data: {
          tenantId: tenant.id,
          tableId: table.id,
          clientId: input.clientId,
          customerName: (input.customerName ?? '').trim(),
          items: stored as unknown as Prisma.InputJsonValue,
          total: round2(stored.reduce((sum, s) => sum + s.unitPrice * s.quantity, 0)),
        },
      });
    });

    // Con confirmación automática el pedido entra solo; si no alcanza el stock, queda para el mozo
    if (tenant.qrAutoConfirm) {
      try {
        await this.confirm(tenant.id, created.id, { actorName: 'Pedido por QR' });
      } catch {
        /* queda pendiente para que lo resuelva una persona */
      }
    }
    const fresh = await this.prisma.qrOrderRequest.findUniqueOrThrow({ where: { id: created.id } });
    return this.clientView(fresh, tenant.kitchenEnabled);
  }

  // Los pedidos de ESTE celular en ESTA mesa, con cómo van avanzando.
  async clientOrders(token: string, ip: string, pin: unknown, clientId: string) {
    const { table, tenant } = await this.resolveWithPin(token, ip, pin);
    const since = new Date(Date.now() - VISIBLE_HOURS * 3600_000);
    const [requests, calls] = await Promise.all([
      this.prisma.qrOrderRequest.findMany({
        where: { tableId: table.id, clientId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.serviceCall.findMany({ where: { tableId: table.id, status: 'OPEN' } }),
    ]);
    return {
      requests: await Promise.all(requests.map((r) => this.clientView(r, tenant.kitchenEnabled))),
      calls: { waiter: calls.some((c) => c.type === 'WAITER'), bill: calls.some((c) => c.type === 'BILL') },
    };
  }

  async cancelRequest(token: string, ip: string, pin: unknown, requestId: string, clientId: string) {
    const { table } = await this.resolveWithPin(token, ip, pin);
    const { count } = await this.prisma.qrOrderRequest.updateMany({
      where: { id: requestId, tableId: table.id, clientId, status: 'PENDING' },
      data: { status: 'CANCELLED', resolvedAt: new Date(), resolvedBy: 'cliente' },
    });
    if (count === 0) throw new ConflictException('Ese pedido ya no se puede cancelar');
    return { ok: true };
  }

  async createCall(token: string, ip: string, pin: unknown, type: 'WAITER' | 'BILL') {
    callLimiter.hit(ip, 'Ya avisaste hace un momento, el mozo está en camino');
    // "Llamar al mozo" se puede usar sin el código de mesa: es justo lo que hace quien no lo tiene. No abre la carta
    // ni permite pedir, y no se duplica mientras haya un aviso abierto. Pedir la cuenta sí exige el código.
    let ctx: Awaited<ReturnType<QrService['resolve']>>;
    if (type === 'WAITER') {
      ipLimiter.hit(ip);
      ctx = await this.resolve(token);
    } else {
      ctx = await this.resolveWithPin(token, ip, pin);
    }
    const { table, tenant } = ctx;
    if (type === 'BILL') {
      const orders = await this.prisma.order.count({ where: { tableId: table.id } });
      if (orders === 0) throw new ConflictException('Todavía no hay consumos en la mesa');
    }
    // Si ya hay un aviso igual abierto no se duplica
    const open = await this.prisma.serviceCall.findFirst({ where: { tableId: table.id, type, status: 'OPEN' } });
    if (!open) await this.prisma.serviceCall.create({ data: { tenantId: tenant.id, tableId: table.id, type } });
    return { ok: true };
  }

  // Estado que ve el cliente. "Confirmado → En preparación → Listo" sale de las órdenes reales de la mesa.
  private async clientView(r: QrOrderRequest, kitchen: boolean) {
    const items = readItems(r.items);
    let step: 'RECEIVED' | 'CONFIRMED' | 'PREPARING' | 'READY' | 'REJECTED' | 'CANCELLED' = 'RECEIVED';
    if (r.status === 'REJECTED') step = 'REJECTED';
    else if (r.status === 'CANCELLED') step = 'CANCELLED';
    else if (r.status === 'CONFIRMED') {
      step = 'CONFIRMED';
      const ids = kitchen && Array.isArray(r.orderIds) ? (r.orderIds as string[]) : [];
      const orders = ids.length ? await this.prisma.order.findMany({ where: { id: { in: ids } }, select: { status: true } }) : [];
      if (orders.length && orders.every((o) => o.status === 'READY')) step = 'READY';
      else if (orders.some((o) => o.status === 'PREPARING' || o.status === 'READY')) step = 'PREPARING';
    }
    return {
      id: r.id,
      step,
      rejectReason: r.rejectReason,
      createdAt: r.createdAt,
      customerName: r.customerName,
      total: r.total,
      items: items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        note: i.note,
        extras: readSnapshot(i.modifiers).map((m) => m.name),
        unitPrice: i.unitPrice,
      })),
    };
  }

  // =====================================================================================
  //  Personal (con sesión): bandeja de pedidos y avisos
  // =====================================================================================

  async inbox(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!qrActive(tenant)) return { active: false, requests: [], calls: [] };

    const since = new Date(Date.now() - 24 * 3600_000);
    const [requests, calls] = await Promise.all([
      this.prisma.qrOrderRequest.findMany({
        where: { tenantId, status: 'PENDING', createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        include: { table: { select: { name: true, waiterId: true, _count: { select: { orders: true } } } } },
      }),
      this.prisma.serviceCall.findMany({
        where: { tenantId, status: 'OPEN', createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        include: { table: { select: { name: true } } },
      }),
    ]);
    return {
      active: true,
      requests: requests.map((r) => ({
        id: r.id,
        tableId: r.tableId,
        tableName: r.table.name,
        tableFree: r.table._count.orders === 0,
        hasWaiter: !!r.table.waiterId,
        customerName: r.customerName,
        createdAt: r.createdAt,
        total: r.total,
        items: readItems(r.items).map((i) => ({
          name: i.name,
          quantity: i.quantity,
          note: i.note,
          extras: readSnapshot(i.modifiers).map((m) => m.name),
          unitPrice: i.unitPrice,
        })),
      })),
      calls: calls.map((c) => ({ id: c.id, tableId: c.tableId, tableName: c.table.name, type: c.type, createdAt: c.createdAt })),
    };
  }

  // Convierte el pedido en órdenes reales de la mesa. Todo o nada: si falta stock o un plato ya no existe,
  // el pedido sigue pendiente y el mozo recibe el motivo. Confirmar dos veces el mismo pedido es imposible.
  async confirm(tenantId: string, requestId: string, opts: { waiterId?: string; actorName: string }) {
    await this.prisma.$transaction(async (tx) => {
      const request = await tx.qrOrderRequest.findFirst({ where: { id: requestId, tenantId } });
      if (!request) throw new NotFoundException('Pedido no encontrado');

      const claimed = await tx.qrOrderRequest.updateMany({
        where: { id: requestId, tenantId, status: 'PENDING' },
        data: { status: 'CONFIRMED', resolvedAt: new Date(), resolvedBy: opts.actorName },
      });
      if (claimed.count === 0) throw new ConflictException('Este pedido ya fue resuelto por otra persona');

      const table = await tx.table.findFirst({ where: { id: request.tableId, tenantId } });
      if (!table) throw new NotFoundException('La mesa ya no existe');

      const lines = readItems(request.items).map((i) => ({
        id: i.menuItemId,
        quantity: i.quantity,
        note: i.note,
        modifiers: i.optionIds,
      }));
      const touched = await this.tables.addItemsTx(tx, tenantId, table.id, lines);

      // La primera confirmación abre la mesa; si no tiene mozo y se indicó uno, queda a su cargo
      let waiterId: string | undefined;
      if (!table.waiterId && opts.waiterId) {
        const waiter = await tx.waiter.findFirst({ where: { id: opts.waiterId, tenantId } });
        if (!waiter) throw new NotFoundException('Mozo no encontrado');
        waiterId = waiter.id;
      }
      await tx.table.update({ where: { id: table.id }, data: { available: false, ...(waiterId ? { waiterId } : {}) } });
      await tx.qrOrderRequest.update({ where: { id: requestId }, data: { orderIds: touched } });
    });
    return { ok: true };
  }

  async reject(tenantId: string, requestId: string, reason: string, actorName: string) {
    const { count } = await this.prisma.qrOrderRequest.updateMany({
      where: { id: requestId, tenantId, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason: reason.trim(), resolvedAt: new Date(), resolvedBy: actorName },
    });
    if (count === 0) {
      const exists = await this.prisma.qrOrderRequest.count({ where: { id: requestId, tenantId } });
      if (!exists) throw new NotFoundException('Pedido no encontrado');
      throw new ConflictException('Este pedido ya fue resuelto por otra persona');
    }
    return { ok: true };
  }

  async resolveCall(tenantId: string, callId: string, actorName: string) {
    const { count } = await this.prisma.serviceCall.updateMany({
      where: { id: callId, tenantId, status: 'OPEN' },
      data: { status: 'DONE', resolvedAt: new Date(), resolvedBy: actorName },
    });
    if (count === 0) {
      const exists = await this.prisma.serviceCall.count({ where: { id: callId, tenantId } });
      if (!exists) throw new NotFoundException('Aviso no encontrado');
    }
    return { ok: true };
  }

  // Mesas con su código de mesa. El código secreto del QR (para imprimir) solo lo recibe el administrador.
  async tablesView(tenantId: string, isAdmin: boolean) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (tenant.qrRequirePin) await this.fillMissing(tenantId, { pins: true, tokens: false });
    const tables = await this.prisma.table.findMany({
      where: { tenantId },
      orderBy: { seq: 'asc' },
      select: { id: true, name: true, qrToken: true, qrPin: true, available: true, sector: { select: { name: true } } },
    });
    return {
      active: qrActive(tenant),
      planIncluded: hasFeature(tenant.plan, 'qr_ordering'),
      requirePin: tenant.qrRequirePin,
      tables: tables.map((t) => ({
        id: t.id,
        name: t.name,
        sector: t.sector?.name ?? '',
        occupied: !t.available,
        hasQr: !!t.qrToken,
        pin: tenant.qrRequirePin ? t.qrPin : '',
        ...(isAdmin ? { token: t.qrToken } : {}),
      })),
    };
  }

  // Crea el código de las mesas que todavía no lo tienen (las ya impresas no cambian)
  async generate(tenantId: string) {
    await this.requirePlan(tenantId);
    return this.fillMissing(tenantId, { pins: true, tokens: true });
  }

  // El QR impreso deja de funcionar y la mesa pasa a tener uno nuevo (por si lo fotografiaron o lo robaron)
  async regenerate(tenantId: string, tableId: string) {
    await this.requirePlan(tenantId);
    const { count } = await this.prisma.table.updateMany({
      where: { id: tableId, tenantId },
      data: { qrToken: newQrToken(), qrPin: newTablePin() },
    });
    if (count === 0) throw new NotFoundException('Mesa no encontrada');
    return { ok: true };
  }

  private async requirePlan(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!hasFeature(tenant.plan, 'qr_ordering')) {
      throw new ForbiddenException(`Tu plan no incluye "${FEATURE_LABELS.qr_ordering}"`);
    }
  }

  private async fillMissing(tenantId: string, what: { pins: boolean; tokens: boolean }) {
    const missing = await this.prisma.table.findMany({
      where: { tenantId, OR: [...(what.tokens ? [{ qrToken: null }] : []), ...(what.pins ? [{ qrPin: '' }] : [])] },
      select: { id: true, qrToken: true, qrPin: true },
    });
    for (const t of missing) {
      await this.prisma.table.update({
        where: { id: t.id },
        data: {
          ...(what.tokens && !t.qrToken ? { qrToken: newQrToken() } : {}),
          ...(what.pins && !t.qrPin ? { qrPin: newTablePin() } : {}),
        },
      });
    }
    return { created: missing.length };
  }
}
