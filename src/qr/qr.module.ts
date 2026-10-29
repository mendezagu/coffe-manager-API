import { Module } from '@nestjs/common';
import { TablesModule } from '../tables/tables.module';
import { QrController, QrPublicController, CartaPublicController } from './qr.controller';
import { QrService } from './qr.service';

@Module({
  imports: [TablesModule],
  controllers: [QrController, QrPublicController, CartaPublicController],
  providers: [QrService],
})
export class QrModule {}
