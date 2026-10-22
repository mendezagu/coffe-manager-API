// Tiempo real: la app no recibe datos por el socket, solo un aviso corto de "esto cambió".
// Al recibirlo, vuelve a pedir lo que necesita con los mismos endpoints de siempre. Así los permisos, los filtros por
// negocio y el formato de los datos siguen siendo los de la API, y el aviso no puede filtrar información.

export type Topic = 'tables' | 'qr' | 'kitchen' | 'shift';

// Sala de cada negocio para el personal (se entra con el login) y para los clientes del QR (se entra con el código de la mesa)
export const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;
export const customersRoom = (tenantId: string) => `customers:${tenantId}`;

// Qué pantallas deben refrescarse cuando alguien modifica algo. La ruta es la de la API (/api/<recurso>/...).
const BY_RESOURCE: Record<string, Topic[]> = {
  tables: ['tables', 'kitchen'], // cargar o quitar platos, liberar o unir mesas: cambia el panel y la cocina
  qr: ['qr', 'tables', 'kitchen'], // confirmar un pedido por QR lo convierte en órdenes de la mesa
  kitchen: ['kitchen', 'tables'], // el estado de un plato se ve también en la tarjeta de la mesa
  sales: ['tables', 'kitchen'], // cobrar cierra la mesa
  waiters: ['tables'],
  sectors: ['tables'],
  shift: ['shift'], // comenzar un turno nuevo: todos los dispositivos del negocio vuelven a pedir desde cuándo cuenta el Balance
};

export function topicsForPath(path: string): Topic[] {
  const [, api, resource] = path.split('?')[0].split('/');
  if (api !== 'api') return [];
  return BY_RESOURCE[resource] ?? [];
}

// El cliente del QR solo sigue el estado de sus pedidos: depende de los pedidos por QR y de la cocina
export const affectsCustomers = (topics: Topic[]) => topics.includes('qr') || topics.includes('kitchen');
