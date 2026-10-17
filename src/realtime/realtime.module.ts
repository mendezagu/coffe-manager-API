import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RealtimeAuth } from './realtime.auth';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeInterceptor } from './realtime.interceptor';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  providers: [RealtimeService, RealtimeAuth, RealtimeGateway, { provide: APP_INTERCEPTOR, useClass: RealtimeInterceptor }],
  exports: [RealtimeService],
})
export class RealtimeModule {}
