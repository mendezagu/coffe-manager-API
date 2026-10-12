import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

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
      user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId },
    };
  }
}
