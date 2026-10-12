import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapMenuItem } from '../common/mappers';

@Injectable()
export class MenuService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const items = await this.prisma.menuItem.findMany();
    return items.map(mapMenuItem);
  }

  async create(createMenuItemDto: any) {
    const item = await this.prisma.menuItem.create({
      data: {
        name: createMenuItemDto.name,
        price: createMenuItemDto.price,
        quantity: createMenuItemDto.quantity ?? 1,
        isPromo: createMenuItemDto.isPromo ?? false,
      },
    });
    return mapMenuItem(item);
  }

  async update(id: string, updateMenuItemDto: any) {
    try {
      const item = await this.prisma.menuItem.update({
        where: { id },
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

  async remove(id: string): Promise<{ message: string }> {
    try {
      await this.prisma.menuItem.delete({ where: { id } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
        throw error;
      }
      // Igual que antes: no había chequeo de existencia, el mensaje se devuelve igual
    }
    return { message: 'Ítem eliminado' };
  }
}
