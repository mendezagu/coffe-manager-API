import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

// Quién es el usuario de hotel que llama (lo deja disponible la guarda en request.hotelUser)
export interface HotelActor {
  id: string;
  email: string;
  name: string;
  hotelId: string;
}

// Marca del token de hotel. Es lo que lo distingue del token del personal de un restaurante: el guard
// general lo rechaza y esta guarda rechaza el del personal, así un token nunca sirve en el otro lado.
export const HOTEL_TOKEN_TYPE = 'hotel';

@Injectable()
export class HotelUserGuard implements CanActivate {
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
    if (payload.typ !== HOTEL_TOKEN_TYPE) throw new UnauthorizedException('Token inválido');

    // Se lee de la base en cada llamada: dar de baja un acceso tiene efecto inmediato
    const user = await this.prisma.hotelUser.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw new UnauthorizedException('Usuario inactivo');

    request.hotelUser = { id: user.id, email: user.email, name: user.name, hotelId: user.hotelId } satisfies HotelActor;
    return true;
  }
}
