import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const [type, token] = (request.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Falta el token');

    let payload: { sub: string; typ?: string };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Token inválido o vencido');
    }

    // El token del portal de hoteles no sirve acá: solo abre las rutas de /api/hotel-portal
    if (payload.typ) throw new UnauthorizedException('Token inválido');

    // Se lee el usuario de la base en cada request: así un cambio de rol o una
    // baja del usuario tiene efecto inmediato, sin esperar a que venza el token.
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw new UnauthorizedException('Usuario inactivo');

    request.user = { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId };
    return true;
  }
}
