import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FEATURE_LABELS, featuresOf, hasFeature } from '../plans/plans';

export interface UpdateSettingsInput {
  name?: string;
  legalName?: string;
  taxIdLabel?: string;
  taxId?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
  ticketFooter?: string;
  logoUrl?: string | null;
  currencyCode?: string;
  locale?: string;
  shiftMorningStart?: number;
  shiftAfternoonStart?: number;
  shiftNightStart?: number;
  splitKitchenBar?: boolean;
}

// Logo: una imagen chica embebida (data URL) o un archivo propio de la app (assets/...).
// SVG no se acepta: puede traer scripts.
const LOGO_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const LOGO_ASSET = /^assets\/[\w./-]+$/;

export function mapSettings(t: Tenant) {
  return {
    id: t.id,
    name: t.name,
    legalName: t.legalName,
    taxIdLabel: t.taxIdLabel,
    taxId: t.taxId,
    address: t.address,
    city: t.city,
    postalCode: t.postalCode,
    phone: t.phone,
    ticketFooter: t.ticketFooter,
    logoUrl: t.logoUrl,
    currencyCode: t.currencyCode,
    locale: t.locale,
    shiftMorningStart: t.shiftMorningStart,
    shiftAfternoonStart: t.shiftAfternoonStart,
    shiftNightStart: t.shiftNightStart,
    // Plan y funciones que incluye. `splitKitchenBar` es lo que el negocio eligió; `splitActive`
    // es lo que realmente rige (elegido Y permitido por el plan).
    plan: t.plan,
    features: featuresOf(t.plan),
    splitKitchenBar: t.splitKitchenBar,
    splitActive: t.splitKitchenBar && hasFeature(t.plan, 'kitchen_bar_split'),
  };
}

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    return mapSettings(tenant);
  }

  async update(tenantId: string, input: UpdateSettingsInput) {
    const current = await this.get(tenantId);

    // Moneda e idioma se prueban con Intl: así un código inválido falla acá y no al formatear precios.
    const currencyCode = input.currencyCode?.trim().toUpperCase();
    const locale = input.locale?.trim();
    try {
      new Intl.NumberFormat(locale ?? current.locale, {
        style: 'currency',
        currency: currencyCode ?? current.currencyCode,
      });
    } catch {
      throw new BadRequestException('Moneda o idioma no válidos (ej: ARS y es-AR)');
    }

    if (input.splitKitchenBar === true && !hasFeature(current.plan, 'kitchen_bar_split')) {
      throw new ForbiddenException(`Tu plan no incluye "${FEATURE_LABELS.kitchen_bar_split}"`);
    }

    const morning = input.shiftMorningStart ?? current.shiftMorningStart;
    const afternoon = input.shiftAfternoonStart ?? current.shiftAfternoonStart;
    const night = input.shiftNightStart ?? current.shiftNightStart;
    if (!(morning < afternoon && afternoon < night)) {
      throw new BadRequestException('Los turnos tienen que empezar en orden: mañana, tarde y noche');
    }

    const logoUrl = this.cleanLogo(input.logoUrl);
    const trim = (v?: string) => (v === undefined ? undefined : v.trim());

    const tenant = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        name: trim(input.name),
        legalName: trim(input.legalName),
        taxIdLabel: trim(input.taxIdLabel),
        taxId: trim(input.taxId),
        address: trim(input.address),
        city: trim(input.city),
        postalCode: trim(input.postalCode),
        phone: trim(input.phone),
        ticketFooter: input.ticketFooter?.trim(),
        logoUrl,
        currencyCode,
        locale,
        shiftMorningStart: input.shiftMorningStart,
        shiftAfternoonStart: input.shiftAfternoonStart,
        shiftNightStart: input.shiftNightStart,
        splitKitchenBar: input.splitKitchenBar,
      },
    });
    return mapSettings(tenant);
  }

  // undefined = no tocar, null/'' = quitar el logo
  private cleanLogo(logo: string | null | undefined): string | null | undefined {
    if (logo === undefined) return undefined;
    if (logo === null || logo === '') return null;
    if (LOGO_DATA_URL.test(logo) || LOGO_ASSET.test(logo)) return logo;
    throw new BadRequestException('El logo tiene que ser una imagen PNG, JPG o WEBP');
  }
}
