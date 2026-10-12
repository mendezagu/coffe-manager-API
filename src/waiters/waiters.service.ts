import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapWaiter } from '../common/mappers';

@Injectable()
export class WaitersService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const waiters = await this.prisma.waiter.findMany({ where: { tenantId } });
    return waiters.map(mapWaiter);
  }

  async create(tenantId: string, createWaiterDto: any) {
    const waiter = await this.prisma.waiter.create({
      data: { tenantId, name: createWaiterDto.name },
    });
    return mapWaiter(waiter);
  }

  async update(tenantId: string, id: string, updateWaiterDto: any) {
    try {
      const waiter = await this.prisma.waiter.update({
        where: { id, tenantId },
        data: { name: updateWaiterDto.name },
      });
      return mapWaiter(waiter);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        // Igual que antes: findByIdAndUpdate de Mongoose no tira 404, devuelve null
        return null;
      }
      throw error;
    }
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    await this.prisma.waiter.deleteMany({ where: { id, tenantId } });
    return { message: 'Mesero eliminado' };
  }
}
