import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MenuItem, MenuItemDocument } from '../menu-item/schemas/menu-item.schema';

@Injectable()
export class MenuService {
  constructor(
    @InjectModel(MenuItem.name) private menuItemModel: Model<MenuItemDocument>,
  ) {}

  async findAll(): Promise<MenuItem[]> {
    return this.menuItemModel.find().exec();
  }

  async create(createMenuItemDto: any): Promise<MenuItem> {
    const newItem = new this.menuItemModel(createMenuItemDto);
    return newItem.save();
  }

  async update(id: string, updateMenuItemDto: any): Promise<MenuItem> {
    return this.menuItemModel.findByIdAndUpdate(id, updateMenuItemDto, { new: true }).exec();
  }

  async remove(id: string): Promise<{ message: string }> {
    await this.menuItemModel.findByIdAndDelete(id).exec();
    return { message: 'Ítem eliminado' };
  }
}
