import { Global, Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage';

@Global()
@Module({
  providers: [ObjectStorageService],
  exports: [ObjectStorageService],
})
export class StorageModule {}
