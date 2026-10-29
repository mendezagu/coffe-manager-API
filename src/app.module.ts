import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { TablesModule } from './tables/tables.module';
import { MenuModule } from './menu/menu.module';
import { WaitersModule } from './waiters/waiters.module';
import { SalesModule } from './sales/sales.module';
import { ReportsModule } from './reports/reports.module';
import { CategoriesModule } from './categories/categories.module';
import { ModifiersModule } from './modifiers/modifiers.module';
import { CashModule } from './cash/cash.module';
import { InventoryModule } from './inventory/inventory.module';
import { SectorsModule } from './sectors/sectors.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { KitchenModule } from './kitchen/kitchen.module';
import { SettingsModule } from './settings/settings.module';
import { QrModule } from './qr/qr.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HotelsModule } from './hotels/hotels.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    StorageModule,
    TablesModule,
    MenuModule,
    WaitersModule,
    SalesModule,
    ReportsModule,
    CategoriesModule,
    ModifiersModule,
    CashModule,
    InventoryModule,
    SectorsModule,
    AuthModule,
    UsersModule,
    KitchenModule,
    SettingsModule,
    QrModule,
    RealtimeModule,
    HotelsModule,
    OnboardingModule,
    ReservationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
