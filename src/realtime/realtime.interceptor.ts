import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RealtimeService } from './realtime.service';
import { topicsForPath } from './realtime.topics';

// Cuando una persona del local modifica algo (crear, editar, borrar) y sale bien, avisa a las pantallas del negocio.
// Los pedidos que hace un cliente por QR (sin sesión) avisan desde el propio servicio del QR.
@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(private readonly realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next.handle();
    const tenantId: string | undefined = req.user?.tenantId;
    const topics = topicsForPath(String(req.originalUrl ?? req.url ?? ''));
    if (!tenantId || topics.length === 0) return next.handle();
    return next.handle().pipe(tap(() => this.realtime.notifyTenant(tenantId, topics)));
  }
}
