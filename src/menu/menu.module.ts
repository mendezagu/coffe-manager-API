import { Module } from '@nestjs/common';
import { MenuController } from './menu.controller';
import { MenuImagesController } from './menu-images.controller';
import { MenuImagesService } from './menu-images.service';
import { MenuService } from './menu.service';

@Module({
  controllers: [MenuController, MenuImagesController],
  providers: [MenuService, MenuImagesService],
})
export class MenuModule {}
