import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

// Marca del token de la consola de plataforma. Igual que el de hotel: el guard general lo rechaza (tiene `typ`)
// y estas guardas rechazan el del personal de un restaurante o de un hotel.
export const PLATFORM_TOKEN_TYPE = 'platform';

export interface PlatformActor {
  id: string;
  email: string;
  name: string;
}

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.platformUser.findUnique({ where: { email: (email ?? '').trim().toLowerCase() } });
    // Mismo mensaje para usuario inexistente y clave incorrecta (no revela cuál falló)
    const ok = user && user.active && (await bcrypt.compare(password ?? '', user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Email o contraseña incorrectos');
    return {
      accessToken: await this.jwt.signAsync({ sub: user.id, typ: PLATFORM_TOKEN_TYPE }),
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
}

@Injectable()
export class PlatformUserGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const [type, token] = (request.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Falta el token');

    let payload: { sub: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Token inválido o vencido');
    }
    if (payload.typ !== PLATFORM_TOKEN_TYPE) throw new UnauthorizedException('Token inválido');

    // Se lee de la base en cada llamada: dar de baja una cuenta tiene efecto inmediato
    const user = await this.prisma.platformUser.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw new UnauthorizedException('Usuario inactivo');

    request.platformUser = { id: user.id, email: user.email, name: user.name } satisfies PlatformActor;
    return true;
  }
}
