import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { TablesModule } from './tables/tables.module';
import { MenuModule } from './menu/menu.module';
import { WaitersModule } from './waiters/waiters.module';
import { BalanceModule } from './balance/balance.module';
import { SectorsModule } from './sectors/sectors.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    TablesModule,
    MenuModule,
    WaitersModule,
    BalanceModule,
    SectorsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
