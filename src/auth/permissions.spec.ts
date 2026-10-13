import 'reflect-metadata';
import { Role } from '@prisma/client';
import { CashController } from '../cash/cash.controller';
import { CategoriesController } from '../categories/categories.controller';
import { InventoryController } from '../inventory/inventory.controller';
import { KitchenController } from '../kitchen/kitchen.controller';
import { QrController, QrPublicController } from '../qr/qr.controller';
import { IS_PUBLIC_KEY } from './public.decorator';
import { MenuController } from '../menu/menu.controller';
import { ModifiersController } from '../modifiers/modifiers.controller';
import { ReportsController } from '../reports/reports.controller';
import { CheckoutController, SalesController } from '../sales/sales.controller';
import { SettingsController } from '../settings/settings.controller';
import { TablesController } from '../tables/tables.controller';
import { UsersController } from '../users/users.controller';
import { ROLES_KEY } from './roles.decorator';

// Quién puede llamar a cada ruta sensible. No necesita base de datos: lee los permisos declarados con @Roles
// (el RolesGuard usa primero lo del método y, si no hay, lo de la clase). Si alguien afloja un permiso sin
// querer, este test falla.
type Ctl = { prototype: any };

function rolesOf(controller: Ctl, method: string): Role[] | 'cualquier usuario con sesión' {
  const handler = controller.prototype[method];
  if (!handler) throw new Error(`${controller.constructor.name} no tiene el método ${method}`);
  const roles: Role[] | undefined = Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller);
  return roles && roles.length ? [...roles].sort() : 'cualquier usuario con sesión';
}

const only = (...roles: Role[]) => [...roles].sort();
const ADMIN = Role.ADMIN;
const CASHIER = Role.CASHIER;
const WAITER = Role.WAITER;
const KITCHEN = Role.KITCHEN;
const BAR = Role.BAR;

describe('Permisos por rol en las rutas', () => {
  it('Balance (historial de ventas con su método de pago) es solo del administrador', () => {
    expect(rolesOf(SalesController, 'findAll')).toEqual(only(ADMIN));
    expect(rolesOf(SalesController, 'findOne')).toEqual(only(ADMIN));
    expect(rolesOf(SalesController, 'removeAll')).toEqual(only(ADMIN));
  });

  it('cobrar lo hacen administrador y cajero; el mozo no cobra', () => {
    expect(rolesOf(CheckoutController, 'checkout')).toEqual(only(ADMIN, CASHIER));
    expect(rolesOf(TablesController, 'resetTable')).toEqual(only(ADMIN, CASHIER));
  });

  it('la caja: administrador y cajero operan; el historial completo es solo del administrador', () => {
    for (const m of ['current', 'open', 'addMovement', 'close']) {
      expect(rolesOf(CashController, m)).toEqual(only(ADMIN, CASHIER));
    }
    expect(rolesOf(CashController, 'history')).toEqual(only(ADMIN));
    expect(rolesOf(CashController, 'detail')).toEqual(only(ADMIN));
  });

  it('reportes, usuarios y cambios de configuración son solo del administrador', () => {
    expect(rolesOf(ReportsController, 'sales')).toEqual(only(ADMIN));
    for (const m of ['findAll', 'create', 'update', 'remove']) expect(rolesOf(UsersController, m)).toEqual(only(ADMIN));
    expect(rolesOf(SettingsController, 'update')).toEqual(only(ADMIN));
  });

  it('el menú, las categorías y los modificadores: todos los ven, solo el administrador los cambia', () => {
    expect(rolesOf(MenuController, 'findAll')).toBe('cualquier usuario con sesión');
    expect(rolesOf(CategoriesController, 'findAll')).toBe('cualquier usuario con sesión');
    expect(rolesOf(ModifiersController, 'findAll')).toBe('cualquier usuario con sesión');
    for (const [ctl, methods] of [
      [MenuController, ['create', 'update', 'remove']],
      [CategoriesController, ['create', 'update', 'remove', 'reorder']],
      [ModifiersController, ['create', 'update', 'remove', 'reorder', 'applyToCategory']],
    ] as [Ctl, string[]][]) {
      for (const m of methods) expect(rolesOf(ctl, m)).toEqual(only(ADMIN));
    }
  });

  it('armar pedidos: administrador, cajero y mozo; cocina y barra no cargan pedidos', () => {
    for (const m of ['addItems', 'assignWaiter', 'linkTables', 'unlinkTables', 'updateQuantities', 'removeOrder']) {
      expect(rolesOf(TablesController, m)).toEqual(only(ADMIN, CASHIER, WAITER));
    }
  });

  it('crear, editar y borrar mesas es solo del administrador', () => {
    for (const m of ['create', 'update', 'remove']) expect(rolesOf(TablesController, m)).toEqual(only(ADMIN));
  });

  it('el inventario (stock, costos, recetas, conteos) es solo del administrador', () => {
    const methods = [
      'summary', 'listItems', 'createItem', 'updateItem', 'removeItem', 'purchase', 'waste', 'adjust',
      'count', 'movements', 'recipes', 'setRecipe', 'options', 'setOptionIngredients',
    ];
    for (const m of methods) expect(rolesOf(InventoryController, m)).toEqual(only(ADMIN));
  });

  it('cocina y barra ven y mueven sus pedidos (y el administrador)', () => {
    for (const m of ['list', 'setManyStatus', 'setStatus']) {
      expect(rolesOf(KitchenController, m)).toEqual(only(ADMIN, KITCHEN, BAR));
    }
  });

  it('pedido por QR: el personal atiende pedidos y avisos; solo el administrador maneja los códigos', () => {
    for (const m of ['inbox', 'confirm', 'reject', 'callDone', 'tables']) {
      expect(rolesOf(QrController, m)).toEqual(only(ADMIN, CASHIER, WAITER));
    }
    for (const m of ['generate', 'regenerate']) expect(rolesOf(QrController, m)).toEqual(only(ADMIN));
  });

  it('pedido por QR: solo la pantalla del cliente es pública; la bandeja del personal exige sesión', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, QrPublicController)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, QrController)).toBeUndefined();
    for (const m of ['inbox', 'confirm', 'reject', 'callDone', 'tables', 'generate', 'regenerate']) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, QrController.prototype[m as keyof QrController])).toBeUndefined();
    }
  });
});
