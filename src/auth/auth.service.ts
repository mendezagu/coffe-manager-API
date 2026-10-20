import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

export const MIN_PASSWORD = 8;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: (email ?? '').trim().toLowerCase() },
    });
    // Mismo mensaje para usuario inexistente y clave incorrecta (no revela cuál falló).
    const ok = user && user.active && (await bcrypt.compare(password ?? '', user.passwordHash));
    if (!user || !ok) throw new UnauthorizedException('Email o contraseña incorrectos');

    return {
      accessToken: await this.jwt.signAsync({ sub: user.id }),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  // Cambia la contraseña del propio usuario. Pide la actual (una sesión abierta en un equipo ajeno no alcanza)
  // y deja de exigir el cambio si estaba pendiente.
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active) throw new UnauthorizedException('Usuario inactivo');
    if (!(await bcrypt.compare(currentPassword ?? '', user.passwordHash))) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
      throw new BadRequestException(`La contraseña nueva tiene que tener al menos ${MIN_PASSWORD} caracteres`);
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException('La contraseña nueva tiene que ser distinta de la actual');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
    });
    return { message: 'Contraseña actualizada' };
  }
}
