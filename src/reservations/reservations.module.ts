import { Module } from '@nestjs/common';
import { ReservationsController, ReservationsPublicController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  controllers: [ReservationsController, ReservationsPublicController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
