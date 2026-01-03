import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type WaiterDocument = Waiter & Document;

@Schema()
export class Waiter {
  @Prop({ required: true })
  name: string;
}

export const WaiterSchema = SchemaFactory.createForClass(Waiter);
