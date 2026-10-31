import { Module } from '@nestjs/common';
import { PlatformUserGuard } from '../hotels/platform-auth';
import { AnnouncementsController, AnnouncementsPlatformController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';

@Module({
  controllers: [AnnouncementsPlatformController, AnnouncementsController],
  providers: [AnnouncementsService, PlatformUserGuard],
})
export class AnnouncementsModule {}
