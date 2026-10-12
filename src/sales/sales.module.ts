import { Module } from '@nestjs/common';
import { CheckoutController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  controllers: [SalesController, CheckoutController],
  providers: [SalesService],
})
export class SalesModule {}
