import { Module } from '@nestjs/common';
import { QrModule } from '../qr/qr.module';
import { DeliveryController, DeliveryPublicController } from './delivery.controller';
import { DeliveryService } from './delivery.service';

@Module({
  imports: [QrModule],
  controllers: [DeliveryController, DeliveryPublicController],
  providers: [DeliveryService],
})
export class DeliveryModule {}
