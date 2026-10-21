import { Module } from '@nestjs/common';
import { ReservationsModule } from '../reservations/reservations.module';
import { HotelPortalController } from './hotel-portal.controller';
import { HotelPortalService } from './hotel-portal.service';
import { HotelsAdminService } from './hotels-admin.service';
import { PlatformTenantsService } from './platform-tenants.service';
import { HotelUserGuard } from './hotel-auth.guard';
import { HotelsController, HotelsPlatformController, HotelsPublicController, PlatformAuthController } from './hotels.controller';
import { PlatformAuthService, PlatformUserGuard } from './platform-auth';
import { HotelsService } from './hotels.service';

@Module({
  imports: [ReservationsModule],
  controllers: [HotelsController, HotelsPublicController, HotelsPlatformController, PlatformAuthController, HotelPortalController],
  providers: [HotelsService, HotelsAdminService, PlatformTenantsService, HotelPortalService, HotelUserGuard, PlatformAuthService, PlatformUserGuard],
})
export class HotelsModule {}
