import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapWaiter } from '../common/mappers';

@Injectable()
export class WaitersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const waiters = await this.prisma.waiter.findMany();
    return waiters.map(mapWaiter);
  }

  async create(createWaiterDto: any) {
    const waiter = await this.prisma.waiter.create({
      data: { name: createWaiterDto.name },
    });
    return mapWaiter(waiter);
  }

  async update(id: string, updateWaiterDto: any) {
    try {
      const waiter = await this.prisma.waiter.update({
        where: { id },
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

  async remove(id: string): Promise<{ message: string }> {
    try {
      await this.prisma.waiter.delete({ where: { id } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
        throw error;
      }
    }
    return { message: 'Mesero eliminado' };
  }
}
