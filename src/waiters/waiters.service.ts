import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Waiter, WaiterDocument } from '../waiter/schemas/waiter.schema';

@Injectable()
export class WaitersService {
  constructor(
    @InjectModel(Waiter.name) private waiterModel: Model<WaiterDocument>,
  ) {}

  async findAll(): Promise<Waiter[]> {
    return this.waiterModel.find().exec();
  }

  async create(createWaiterDto: any): Promise<Waiter> {
    const newWaiter = new this.waiterModel(createWaiterDto);
    return newWaiter.save();
  }

  async update(id: string, updateWaiterDto: any): Promise<Waiter> {
    return this.waiterModel.findByIdAndUpdate(id, updateWaiterDto, { new: true }).exec();
  }

  async remove(id: string): Promise<{ message: string }> {
    await this.waiterModel.findByIdAndDelete(id).exec();
    return { message: 'Mesero eliminado' };
  }
}
