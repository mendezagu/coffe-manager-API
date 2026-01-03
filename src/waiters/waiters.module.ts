import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WaitersController } from './waiters.controller';
import { WaitersService } from './waiters.service';
import { Waiter, WaiterSchema } from '../waiter/schemas/waiter.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Waiter.name, schema: WaiterSchema }]),
  ],
  controllers: [WaitersController],
  providers: [WaitersService],
})
export class WaitersModule {}
