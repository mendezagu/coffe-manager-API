import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { Feature, featureDeniedMessage, hasFeature } from './plans';

const FEATURE_KEY = 'requires_feature';

// Corta la ruta si el plan del negocio no incluye la función. Va después del login y de los roles (que son globales).
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<Feature>(FEATURE_KEY, [context.getHandler(), context.getClass()]);
    if (!feature) return true;
    const tenantId = context.switchToHttp().getRequest().user?.tenantId;
    if (!tenantId) return true; // sin sesión de negocio no hay plan que revisar (lo frena el login)
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
    if (!tenant || !hasFeature(tenant.plan, feature)) throw new ForbiddenException(featureDeniedMessage(feature));
    return true;
  }
}

// @RequiresFeature('reservations') en una ruta o en un controlador entero
export const RequiresFeature = (feature: Feature) => applyDecorators(SetMetadata(FEATURE_KEY, feature), UseGuards(FeatureGuard));
