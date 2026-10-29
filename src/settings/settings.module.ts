import { Module } from '@nestjs/common';
import { BrandImagesController } from './brand-images.controller';
import { BrandImagesService } from './brand-images.service';
import { SettingsController, ShiftController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController, ShiftController, BrandImagesController],
  providers: [SettingsService, BrandImagesService],
})
export class SettingsModule {}
