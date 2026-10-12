import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { mapBalance } from '../common/mappers';

@Injectable()
export class BalanceService {
  constructor(private prisma: PrismaService) {}

  async findAll(tenantId: string) {
    const balances = await this.prisma.balance.findMany({ where: { tenantId } });
    return balances.map(mapBalance);
  }

  async create(tenantId: string, createBalanceDto: any) {
    if (!createBalanceDto.paymentMethod) {
      throw new Error('El método de pago es obligatorio');
    }

    try {
      const balance = await this.prisma.balance.create({
        data: {
          tenantId,
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

  // Solo borra los balances del negocio del usuario, nunca los de otros.
  async removeAll(tenantId: string): Promise<{ message: string }> {
    await this.prisma.balance.deleteMany({ where: { tenantId } });
    return { message: 'Todos los balances han sido eliminados' };
  }
}
