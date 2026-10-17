import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { RealtimeAuth, SocketAccess } from './realtime.auth';
import { RealtimeService } from './realtime.service';

// Máximo de conexiones abiertas por dirección IP: frena a quien quiera saturar el servidor abriendo sockets
const MAX_PER_IP = 40;
// setTimeout no admite más de ~24 días
const MAX_TIMER_MS = 2 ** 31 - 1;

@WebSocketGateway({ namespace: '/realtime' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger('Realtime');
  private readonly perIp = new Map<string, number>();
  private readonly expiry = new Map<string, NodeJS.Timeout>();

  constructor(private readonly auth: RealtimeAuth, private readonly realtime: RealtimeService) {}

  afterInit(server: Namespace) {
    this.realtime.setServer(server);
  }

  async handleConnection(client: Socket) {
    const ip = this.ipOf(client);
    const open = (this.perIp.get(ip) ?? 0) + 1;
    this.perIp.set(ip, open);
    if (open > MAX_PER_IP) {
      client.disconnect(true);
      return;
    }

    let access: SocketAccess | null = null;
    try {
      access = await this.auth.authenticate(client.handshake.auth);
    } catch (e) {
      this.log.warn(`No se pudo validar una conexión: ${(e as Error).message}`);
    }
    if (!access || (access.expiresInMs !== undefined && access.expiresInMs <= 0)) {
      client.disconnect(true);
      return;
    }

    await client.join(access.rooms);
    if (access.expiresInMs !== undefined) {
      this.expiry.set(client.id, setTimeout(() => client.disconnect(true), Math.min(access.expiresInMs, MAX_TIMER_MS)));
    }
  }

  handleDisconnect(client: Socket) {
    const ip = this.ipOf(client);
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, left);
    const timer = this.expiry.get(client.id);
    if (timer) clearTimeout(timer);
    this.expiry.delete(client.id);
  }

  // Detrás del proxy del hosting la IP real viene en X-Forwarded-For
  private ipOf(client: Socket): string {
    const forwarded = String(client.handshake.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return forwarded || client.handshake.address || 'desconocida';
  }
}
