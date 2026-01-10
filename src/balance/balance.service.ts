import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Balance, BalanceDocument } from './schemas/balance.schema';

@Injectable()
export class BalanceService {
  constructor(
    @InjectModel(Balance.name) private balanceModel: Model<BalanceDocument>,
  ) {}

  async findAll(): Promise<Balance[]> {
    return this.balanceModel.find().exec();
  }

  async create(createBalanceDto: any): Promise<Balance> {
    console.log('DTO recibido en backend:', createBalanceDto);
    if (!createBalanceDto.paymentMethod) {
      throw new Error('El método de pago es obligatorio');
    }
    // Log explícito del valor recibido
    console.log('Valor recibido para paymentMethod:', createBalanceDto.paymentMethod);

    // Validación para evitar duplicados por orderId
    const duplicate = await this.balanceModel.findOne({ orderId: createBalanceDto.orderId });
    if (duplicate) {
      throw new Error('Ya existe un balance para esta orden.');
    }

    // Forzar el guardado del campo aunque el esquema no lo reconozca
    const newBalance = new this.balanceModel({
      ...createBalanceDto,
      paymentMethod: createBalanceDto.paymentMethod
    });
    console.log('Documento antes de guardar:', newBalance);
    const saved = await newBalance.save();
    console.log('Documento guardado en Mongo:', saved);
    return saved;
  }

  async removeAll(): Promise<{ message: string }> {
    await this.balanceModel.deleteMany({}).exec();
    return { message: 'Todos los balances han sido eliminados' };
  }
}
