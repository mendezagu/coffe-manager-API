import { Prisma, PrismaClient } from '@prisma/client';

// Avisos de los clientes desde el QR ("Llamar al mozo" / "Pedir la cuenta").
type Db = PrismaClient | Prisma.TransactionClient;

// Un aviso sin atender caduca: pasado este tiempo ya no se le muestra a nadie ni bloquea uno nuevo
export const CALL_TTL_HOURS = 24;
export const callsSince = () => new Date(Date.now() - CALL_TTL_HOURS * 3600_000);

// Al liberar una mesa se cierran sus avisos (y los de las mesas unidas a ella): si no, quedarían para el próximo cliente.
// Tiene que ejecutarse ANTES de desvincular las mesas unidas.
export const closeTableCalls = (db: Db, tenantId: string, tableId: string) =>
  db.serviceCall.updateMany({
    where: { tenantId, status: 'OPEN', OR: [{ tableId }, { table: { controlledById: tableId } }] },
    data: { status: 'DONE', resolvedAt: new Date(), resolvedBy: 'mesa liberada' },
  });
