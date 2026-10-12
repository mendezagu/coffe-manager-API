import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapMenuItem } from '../common/mappers';

@Injectable()
export class MenuService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const items = await this.prisma.menuItem.findMany({ where: { tenantId } });
    return items.map(mapMenuItem);
  }

  async create(tenantId: string, createMenuItemDto: any) {
    const item = await this.prisma.menuItem.create({
      data: {
        tenantId,
        name: createMenuItemDto.name,
        price: createMenuItemDto.price,
        quantity: createMenuItemDto.quantity ?? 1,
        isPromo: createMenuItemDto.isPromo ?? false,
      },
    });
    return mapMenuItem(item);
  }

  async update(tenantId: string, id: string, updateMenuItemDto: any) {
    try {
      const item = await this.prisma.menuItem.update({
        where: { id, tenantId },
        data: {
          name: updateMenuItemDto.name,
          price: updateMenuItemDto.price,
          // undefined = Prisma no toca la columna (ediciones parciales)
          isPromo: updateMenuItemDto.isPromo,
        },
      });
      return mapMenuItem(item);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        // Igual que antes: findByIdAndUpdate de Mongoose no tira 404, devuelve null
        return null;
      }
      throw error;
    }
  }

  async remove(tenantId: string, id: string): Promise<{ message: string }> {
    // deleteMany no falla si no existe: el mensaje se devuelve igual, como antes
    await this.prisma.menuItem.deleteMany({ where: { id, tenantId } });
    return { message: 'Ítem eliminado' };
  }
}
