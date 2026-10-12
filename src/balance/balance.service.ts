import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapBalance } from '../common/mappers';

@Injectable()
export class BalanceService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const balances = await this.prisma.balance.findMany();
    return balances.map(mapBalance);
  }

  async create(createBalanceDto: any) {
    if (!createBalanceDto.paymentMethod) {
      throw new Error('El método de pago es obligatorio');
    }

    try {
      const balance = await this.prisma.balance.create({
        data: {
          orderId: createBalanceDto.orderId,
          tableName: createBalanceDto.tableName,
          waiterName: createBalanceDto.waiterName,
          totalAmount: createBalanceDto.totalAmount,
          paymentMethod: createBalanceDto.paymentMethod,
        },
      });
      return mapBalance(balance);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('Ya existe un balance para esta orden.');
      }
      throw error;
    }
  }

  async removeAll(): Promise<{ message: string }> {
    await this.prisma.balance.deleteMany({});
    return { message: 'Todos los balances han sido eliminados' };
  }
}
