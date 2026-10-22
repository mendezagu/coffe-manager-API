import { Module } from '@nestjs/common';
import { SettingsController, ShiftController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  controllers: [SettingsController, ShiftController],
  providers: [SettingsService],
})
export class SettingsModule {}
