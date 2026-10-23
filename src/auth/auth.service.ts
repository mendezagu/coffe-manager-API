import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeLoginCode, normalizeUsername } from './login-code';

export const MIN_PASSWORD = 8;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  // El personal entra con el código de su local y su usuario. El usuario es único dentro de cada local, no en toda la
  // plataforma: dos restaurantes pueden tener cada uno su "mozo". Sin código se acepta (versiones anteriores de la app)
  // siempre que ese usuario y esa contraseña correspondan a una sola cuenta.
  async login(username: string, password: string, code?: string) {
    const email = normalizeUsername(username);
    const loginCode = normalizeLoginCode(code);

    let candidates: User[] = [];
    if (loginCode) {
      const tenant = await this.prisma.tenant.findUnique({ where: { loginCode }, select: { id: true } });
      if (tenant) candidates = await this.prisma.user.findMany({ where: { tenantId: tenant.id, email } });
    } else {
      candidates = await this.prisma.user.findMany({ where: { email }, take: 5 });
    }

    // Se prueba la contraseña contra cada cuenta con ese usuario. Mismo mensaje para usuario inexistente, local
    // inexistente y clave incorrecta (no revela cuál falló).
    const matches = [];
    for (const candidate of candidates) {
      if (candidate.active && (await bcrypt.compare(password ?? '', candidate.passwordHash))) matches.push(candidate);
    }
    if (matches.length === 0) throw new UnauthorizedException('Usuario o contraseña incorrectos');
    if (matches.length > 1) throw new BadRequestException('Ingresá el código de tu local para continuar');
    const user = matches[0];
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

  // Datos públicos mínimos de un local, para que quien entra confirme que escribió bien el código (nombre y logo)
  async localInfo(code: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { loginCode: normalizeLoginCode(code) },
      select: { loginCode: true, name: true, city: true, logoUrl: true },
    });
    if (!tenant) throw new NotFoundException('No encontramos ese local. Revisá el código.');
    return { code: tenant.loginCode, name: tenant.name, city: tenant.city, logoUrl: tenant.logoUrl };
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
