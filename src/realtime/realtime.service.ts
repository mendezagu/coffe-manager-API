import { Injectable } from '@nestjs/common';
import { affectsCustomers, customersRoom, tenantRoom, Topic } from './realtime.topics';

// Lo mínimo que se necesita del servidor de sockets (así se puede probar sin levantar uno)
export interface Broadcaster {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

@Injectable()
export class RealtimeService {
  private server?: Broadcaster;

  setServer(server: Broadcaster) {
    this.server = server;
  }

  // Avisa a todas las pantallas del negocio que algo cambió. Nunca rompe la operación que lo originó.
  notifyTenant(tenantId: string, topics: Topic[]) {
    if (!this.server || !tenantId || topics.length === 0) return;
    try {
      for (const topic of topics) this.server.to(tenantRoom(tenantId)).emit('changed', { topic });
      if (affectsCustomers(topics)) this.server.to(customersRoom(tenantId)).emit('changed', { topic: 'orders' });
    } catch {
      /* el aviso es un extra: si falla, las pantallas se actualizan igual por la consulta periódica */
    }
  }
}
