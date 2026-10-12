import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

const SELECT = { id: true, email: true, name: true, role: true, active: true, createdAt: true };

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // Crea el primer admin si todavía no hay ningún usuario (ADMIN_EMAIL / ADMIN_PASSWORD).
  // Va en el primer negocio de la base (la migración siempre deja uno). Para sumar más
  // negocios con su admin: npm run tenant:create.
  async onModuleInit() {
    if ((await this.prisma.user.count()) > 0) return;
    const email = this.config.get<string>('ADMIN_EMAIL');
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!email || !password) {
      this.logger.warn('No hay usuarios. Definí ADMIN_EMAIL y ADMIN_PASSWORD para crear el primer admin.');
      return;
    }
    const tenant = await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!tenant) {
      this.logger.warn('No hay ningún negocio en la base; corré las migraciones.');
      return;
    }
    await this.create(tenant.id, { email, password, name: 'Administrador', role: Role.ADMIN });
    this.logger.log(`Admin inicial creado: ${email}`);
  }

  findAll(tenantId: string) {
    return this.prisma.user.findMany({ where: { tenantId }, select: SELECT, orderBy: { createdAt: 'asc' } });
  }

  async create(tenantId: string, data: { email: string; password: string; name: string; role: Role }) {
    try {
      return await this.prisma.user.create({
        data: {
          tenantId,
          email: data.email.trim().toLowerCase(),
          name: data.name.trim(),
          role: data.role,
          passwordHash: await bcrypt.hash(data.password, 10),
        },
        select: SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ya existe un usuario con ese email');
      }
      throw e;
    }
  }

  async update(
    tenantId: string,
    id: string,
    data: { name?: string; role?: Role; active?: boolean; password?: string },
    actorId: string,
  ) {
    const current = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('Usuario no encontrado');

    // Evita que el negocio se quede sin admins (o que el admin se bloquee a sí mismo).
    const losesAdmin =
      current.role === Role.ADMIN &&
      ((data.role && data.role !== Role.ADMIN) || data.active === false);
    if (losesAdmin) await this.assertAnotherAdmin(tenantId, id);
    if (id === actorId && data.active === false) {
      throw new BadRequestException('No podés desactivarte a vos mismo');
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        name: data.name?.trim(),
        role: data.role,
        active: data.active,
        passwordHash: data.password ? await bcrypt.hash(data.password, 10) : undefined,
      },
      select: SELECT,
    });
  }

  async remove(tenantId: string, id: string, actorId: string) {
    if (id === actorId) throw new BadRequestException('No podés eliminarte a vos mismo');
    const current = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!current) throw new NotFoundException('Usuario no encontrado');
    if (current.role === Role.ADMIN) await this.assertAnotherAdmin(tenantId, id);
    await this.prisma.user.delete({ where: { id } });
    return { deleted: true };
  }

  private async assertAnotherAdmin(tenantId: string, excludeId: string) {
    const others = await this.prisma.user.count({
      where: { tenantId, role: Role.ADMIN, active: true, id: { not: excludeId } },
    });
    if (others === 0) throw new BadRequestException('Tiene que quedar al menos un admin activo');
  }
}
