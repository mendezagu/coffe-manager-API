import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hasFeature } from '../plans/plans';
import { PrismaService } from '../prisma/prisma.service';
import { customersRoom, tenantRoom } from './realtime.topics';

const QR_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export interface SocketAuth {
  token?: unknown; // personal del local: el mismo JWT del login
  qrToken?: unknown; // cliente: el código secreto del QR de su mesa
}

export interface SocketAccess {
  rooms: string[];
  // Cuánto falta para que venza la sesión: al vencer se corta el socket y la app vuelve a conectarse con su sesión nueva
  expiresInMs?: number;
}

// Decide a qué salas puede entrar cada conexión. Sin credenciales válidas devuelve null y se la desconecta.
@Injectable()
export class RealtimeAuth {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async authenticate(auth: SocketAuth | undefined): Promise<SocketAccess | null> {
    if (typeof auth?.token === 'string' && auth.token) return this.staff(auth.token);
    if (typeof auth?.qrToken === 'string' && QR_TOKEN_RE.test(auth.qrToken)) return this.customer(auth.qrToken);
    return null;
  }

  private async staff(token: string): Promise<SocketAccess | null> {
    let payload: { sub: string; exp?: number; iat?: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }
    // Igual que en las consultas HTTP: se mira el usuario en la base para que una baja tenga efecto inmediato
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return null;
    if (user.passwordChangedAt && typeof payload.iat === 'number' && payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) return null;
    return {
      rooms: [tenantRoom(user.tenantId)],
      expiresInMs: payload.exp ? payload.exp * 1000 - Date.now() : undefined,
    };
  }

  private async customer(qrToken: string): Promise<SocketAccess | null> {
    const table = await this.prisma.table.findUnique({ where: { qrToken }, include: { tenant: true } });
    if (!table || !table.tenant.qrEnabled || !hasFeature(table.tenant.plan, 'qr_ordering')) return null;
    return { rooms: [customersRoom(table.tenantId)] };
  }
}
