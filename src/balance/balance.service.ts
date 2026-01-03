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
    const newBalance = new this.balanceModel(createBalanceDto);
    return newBalance.save();
  }

  async removeAll(): Promise<{ message: string }> {
    await this.balanceModel.deleteMany({}).exec();
    return { message: 'Todos los balances han sido eliminados' };
  }
}
