import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BalanceDocument = Balance & Document;


@Schema()
export class Balance {
  @Prop({ required: true })
  tableName: string;

  @Prop({ required: true })
  waiterName: string;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ required: true })
  paymentMethod: string;

  @Prop({ default: Date.now })
  date: Date;
}

export const BalanceSchema = SchemaFactory.createForClass(Balance);
