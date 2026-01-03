import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

@Schema({ _id: true })
export class Order {
  @Prop({ type: Types.ObjectId, ref: 'MenuItem' })
  menuItem: Types.ObjectId;

  @Prop({ default: 1 })
  quantity: number;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

export type TableDocument = Table & Document;

@Schema()
export class Table {
  @Prop({ required: true })
  name: string;

  @Prop({ default: true })
  available: boolean;

  @Prop({ type: [OrderSchema], default: [] })
  orders: Order[];

  @Prop({ type: [String], default: [] })
  linkedTables: string[];

  @Prop({ default: null })
  controlledBy: string;

  @Prop({ default: null })
  waiterId: string;

  @Prop({ default: null })
  waiterName: string;
}

export const TableSchema = SchemaFactory.createForClass(Table);
