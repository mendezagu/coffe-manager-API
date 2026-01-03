import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BalanceDocument = Balance & Document;

@Schema()
export class Balance {
  @Prop()
  tableName: string;

  @Prop()
  waiterName: string;

  @Prop()
  totalAmount: number;

  @Prop({ default: Date.now })
  date: Date;
}

export const BalanceSchema = SchemaFactory.createForClass(Balance);
