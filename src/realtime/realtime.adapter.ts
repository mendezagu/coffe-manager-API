import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';

// Servidor de sockets con los mismos orígenes permitidos (CORS_ORIGINS) que el resto de la API.
// Sin CORS_ORIGINS queda abierto, igual que el CORS de las consultas HTTP, para no romper el desarrollo.
export class RealtimeAdapter extends IoAdapter {
  constructor(app: INestApplicationContext, private readonly origins?: string[]) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins?.length ? this.origins : true } });
  }
}
