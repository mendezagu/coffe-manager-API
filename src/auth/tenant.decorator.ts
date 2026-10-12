import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Id del negocio del usuario logueado. Sale de la base (JwtAuthGuard), nunca del cliente:
// con él se filtra toda consulta, así un negocio no puede ver ni tocar datos de otro.
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().user.tenantId;
});
