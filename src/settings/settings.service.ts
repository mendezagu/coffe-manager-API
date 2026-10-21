import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Tenant } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FEATURE_LABELS, featuresOf, hasFeature } from '../plans/plans';
import { slugify, validateRules } from '../reservations/reservations.logic';

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
  brandColor?: string;
  currencyCode?: string;
  locale?: string;
  shiftMorningStart?: number;
  shiftAfternoonStart?: number;
  shiftNightStart?: number;
  kitchenEnabled?: boolean;
  splitKitchenBar?: boolean;
  cashierDiscounts?: boolean;
  waiterCanRemoveItems?: boolean;
  cashierCanRemoveItems?: boolean;
  tipEnabled?: boolean;
  tipSuggestedPct?: number;
  commissionEnabled?: boolean;
  commissionPct?: number;
  reservationsEnabled?: boolean;
  reservationOpenMin?: number;
  reservationCloseMin?: number;
  reservationDays?: number[];
  reservationSlotMin?: number;
  reservationDurationMin?: number;
  reservationCapacity?: number;
  reservationMaxParty?: number;
  reservationAdvanceDays?: number;
  reservationNoticeMin?: number;
  requireOpenRegister?: boolean;
  inventoryEnabled?: boolean;
  blockOutOfStock?: boolean;
  qrEnabled?: boolean;
  qrAutoConfirm?: boolean;
  qrRequirePin?: boolean;
  onboardingDone?: boolean;
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
    brandColor: t.brandColor,
    currencyCode: t.currencyCode,
    locale: t.locale,
    shiftMorningStart: t.shiftMorningStart,
    shiftAfternoonStart: t.shiftAfternoonStart,
    shiftNightStart: t.shiftNightStart,
    // Plan y funciones que incluye. `splitKitchenBar` es lo que el negocio eligió; `splitActive`
    // es lo que realmente rige (elegido Y permitido por el plan).
    plan: t.plan,
    features: featuresOf(t.plan),
    // Cocina: lo que el negocio eligió. Separar cocina y barra solo rige si hay cocina, lo eligió y el plan lo permite.
    kitchenEnabled: t.kitchenEnabled,
    splitKitchenBar: t.splitKitchenBar,
    splitActive: t.kitchenEnabled && t.splitKitchenBar && hasFeature(t.plan, 'kitchen_bar_split'),
    // Propinas y caja
    cashierDiscounts: t.cashierDiscounts,
    waiterCanRemoveItems: t.waiterCanRemoveItems,
    cashierCanRemoveItems: t.cashierCanRemoveItems,
    tipEnabled: t.tipEnabled,
    tipSuggestedPct: t.tipSuggestedPct,
    // Comisión de mozos
    commissionEnabled: t.commissionEnabled,
    commissionPct: t.commissionPct,
    // Reservas
    reservationsEnabled: t.reservationsEnabled,
    reservationSlug: t.reservationSlug,
    reservationOpenMin: t.reservationOpenMin,
    reservationCloseMin: t.reservationCloseMin,
    reservationDays: t.reservationDays ?? [],
    reservationSlotMin: t.reservationSlotMin,
    reservationDurationMin: t.reservationDurationMin,
    reservationCapacity: t.reservationCapacity,
    reservationMaxParty: t.reservationMaxParty,
    reservationAdvanceDays: t.reservationAdvanceDays,
    reservationNoticeMin: t.reservationNoticeMin,
    requireOpenRegister: t.requireOpenRegister,
    // Inventario: lo que el negocio eligió y lo que realmente rige (elegido Y permitido por el plan)
    inventoryEnabled: t.inventoryEnabled,
    inventoryActive: t.inventoryEnabled && hasFeature(t.plan, 'inventory'),
    blockOutOfStock: t.blockOutOfStock,
    // Pedido por QR: lo que eligió el negocio y lo que realmente rige (elegido Y permitido por el plan)
    qrEnabled: t.qrEnabled,
    qrActive: t.qrEnabled && hasFeature(t.plan, 'qr_ordering'),
    qrAutoConfirm: t.qrAutoConfirm,
    qrRequirePin: t.qrRequirePin,
    onboardingDone: t.onboardingDone,
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

    if (input.inventoryEnabled === true && !hasFeature(current.plan, 'inventory')) {
      throw new ForbiddenException(`Tu plan no incluye "${FEATURE_LABELS.inventory}"`);
    }

    if (input.qrEnabled === true && !hasFeature(current.plan, 'qr_ordering')) {
      throw new ForbiddenException(`Tu plan no incluye "${FEATURE_LABELS.qr_ordering}"`);
    }

    // Con la comisión activa hace falta un porcentaje real (entre 0 y 100, sin pasarse de dos decimales)
    const commissionOn = input.commissionEnabled ?? current.commissionEnabled;
    const commissionPct = input.commissionPct ?? current.commissionPct;
    if (commissionOn && !(commissionPct > 0 && commissionPct <= 100)) {
      throw new BadRequestException('Poné un porcentaje de comisión mayor a 0 y hasta 100');
    }

    // Reservas: las reglas tienen que tener sentido (se valida con lo nuevo mezclado con lo que ya había)
    const rules = {
      openMin: input.reservationOpenMin ?? current.reservationOpenMin,
      closeMin: input.reservationCloseMin ?? current.reservationCloseMin,
      days: input.reservationDays ?? current.reservationDays,
      slotMin: input.reservationSlotMin ?? current.reservationSlotMin,
      durationMin: input.reservationDurationMin ?? current.reservationDurationMin,
      capacity: input.reservationCapacity ?? current.reservationCapacity,
      maxParty: input.reservationMaxParty ?? current.reservationMaxParty,
      advanceDays: input.reservationAdvanceDays ?? current.reservationAdvanceDays,
      noticeMin: input.reservationNoticeMin ?? current.reservationNoticeMin,
    };
    const touchesReservations = Object.keys(input).some((k) => k.startsWith('reservation'));
    if (touchesReservations) {
      const problem = validateRules(rules);
      if (problem) throw new BadRequestException(problem);
    }
    // La primera vez que se activan se le arma la dirección pública (/reservar/<nombre>)
    let reservationSlug: string | undefined;
    if ((input.reservationsEnabled ?? current.reservationsEnabled) && !current.reservationSlug) {
      reservationSlug = await this.freeReservationSlug(input.name?.trim() || current.name);
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
        brandColor: input.brandColor === undefined ? undefined : this.cleanColor(input.brandColor),
        currencyCode,
        locale,
        shiftMorningStart: input.shiftMorningStart,
        shiftAfternoonStart: input.shiftAfternoonStart,
        shiftNightStart: input.shiftNightStart,
        kitchenEnabled: input.kitchenEnabled ?? undefined,
        splitKitchenBar: input.splitKitchenBar,
        cashierDiscounts: input.cashierDiscounts ?? undefined,
        waiterCanRemoveItems: input.waiterCanRemoveItems ?? undefined,
        cashierCanRemoveItems: input.cashierCanRemoveItems ?? undefined,
        tipEnabled: input.tipEnabled ?? undefined,
        tipSuggestedPct: input.tipSuggestedPct ?? undefined,
        commissionEnabled: input.commissionEnabled ?? undefined,
        commissionPct: input.commissionPct === undefined ? undefined : Math.round(input.commissionPct * 100) / 100,
        reservationsEnabled: input.reservationsEnabled ?? undefined,
        reservationSlug,
        reservationOpenMin: input.reservationOpenMin,
        reservationCloseMin: input.reservationCloseMin,
        reservationDays: input.reservationDays === undefined ? undefined : [...new Set(input.reservationDays)].sort(),
        reservationSlotMin: input.reservationSlotMin,
        reservationDurationMin: input.reservationDurationMin,
        reservationCapacity: input.reservationCapacity,
        reservationMaxParty: input.reservationMaxParty,
        reservationAdvanceDays: input.reservationAdvanceDays,
        reservationNoticeMin: input.reservationNoticeMin,
        requireOpenRegister: input.requireOpenRegister ?? undefined,
        inventoryEnabled: input.inventoryEnabled ?? undefined,
        blockOutOfStock: input.blockOutOfStock ?? undefined,
        qrEnabled: input.qrEnabled ?? undefined,
        qrAutoConfirm: input.qrAutoConfirm ?? undefined,
        qrRequirePin: input.qrRequirePin ?? undefined,
        onboardingDone: input.onboardingDone ?? undefined,
      },
    });
    return mapSettings(tenant);
  }

  // Dirección pública para reservar: el nombre del negocio y, si ya existe, un sufijo para que sea única
  private async freeReservationSlug(name: string): Promise<string> {
    const base = slugify(name);
    for (let i = 0; i < 20; i++) {
      const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      if (!(await this.prisma.tenant.findUnique({ where: { reservationSlug: candidate } }))) return candidate;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  // Color de marca: #RRGGBB (el frontend arma el resto de tonos y el color del texto)
  private cleanColor(color: string): string {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new BadRequestException('El color tiene que ser un hexadecimal como #1b2822');
    return color.toLowerCase();
  }

  // undefined = no tocar, null/'' = quitar el logo
  private cleanLogo(logo: string | null | undefined): string | null | undefined {
    if (logo === undefined) return undefined;
    if (logo === null || logo === '') return null;
    if (LOGO_DATA_URL.test(logo) || LOGO_ASSET.test(logo)) return logo;
    throw new BadRequestException('El logo tiene que ser una imagen PNG, JPG o WEBP');
  }
}
