import { Module } from '@nestjs/common';
import { CheckoutController, CounterController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  controllers: [SalesController, CheckoutController, CounterController],
  providers: [SalesService],
})
export class SalesModule {}
