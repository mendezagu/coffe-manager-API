import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService, publicImageUrl } from '../storage/object-storage';

// Imágenes de apariencia de la carta: la portada (banda de arriba) y el fondo de la página.
// Mismo camino que las fotos de los platos: se sube a R2 (directo o por la API) y se comprueba antes de asociarla.
export const BRAND_KINDS = ['cover', 'background'] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const MAX_BRAND_BYTES = 600 * 1024;
const TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const FIELD: Record<BrandKind, 'coverImageKey' | 'backgroundImageKey'> = { cover: 'coverImageKey', background: 'backgroundImageKey' };

export function assertKind(kind: unknown): BrandKind {
  if (!(BRAND_KINDS as readonly string[]).includes(String(kind))) throw new BadRequestException('Tipo de imagen no válido');
  return kind as BrandKind;
}

@Injectable()
export class BrandImagesService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  private assertEnabled() {
    if (!this.storage.enabled) throw new ServiceUnavailableException('La subida de imágenes todavía no está disponible');
  }

  private async result(tenantId: string) {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { coverImageKey: true, backgroundImageKey: true } });
    return { coverImageUrl: publicImageUrl(t.coverImageKey), backgroundImageUrl: publicImageUrl(t.backgroundImageKey) };
  }

  /** Paso 1: permiso para subir UNA imagen de este tipo. */
  async uploadUrl(tenantId: string, kind: BrandKind, contentType: string) {
    this.assertEnabled();
    const ext = TYPES[contentType];
    if (!ext) throw new BadRequestException('La imagen tiene que ser JPG, PNG o WebP');
    const key = `t/${tenantId}/brand/${kind}-${randomBytes(8).toString('hex')}.${ext}`;
    return { key, uploadUrl: this.storage.presignPut(key, contentType), headers: { 'Content-Type': contentType }, maxBytes: MAX_BRAND_BYTES };
  }

  /** Alternativa: la imagen llega a la API (ya achicada) y la API la guarda. */
  async uploadFile(tenantId: string, kind: BrandKind, contentType: string, data: Buffer) {
    const slot = await this.uploadUrl(tenantId, kind, contentType);
    if (data.length === 0) throw new BadRequestException('La imagen está vacía');
    if (data.length > MAX_BRAND_BYTES) throw new BadRequestException('La imagen pesa demasiado. Probá con una más chica.');
    try {
      await this.storage.put(slot.key, data, contentType);
    } catch {
      throw new ServiceUnavailableException('No se pudo guardar la imagen en este momento. Intentá de nuevo.');
    }
    return this.attach(tenantId, kind, slot.key);
  }

  /** Paso 2: la imagen ya está subida; se comprueba y queda asociada (la anterior se borra). */
  async attach(tenantId: string, kind: BrandKind, key: string) {
    this.assertEnabled();
    const valid = new RegExp(`^t/${tenantId}/brand/${kind}-[0-9a-f]{16}\\.(webp|jpg|png)$`);
    if (!valid.test(key ?? '')) throw new BadRequestException('Imagen no válida');

    const stored = await this.storage.head(key);
    if (!stored) throw new BadRequestException('No encontramos la imagen subida. Probá de nuevo.');
    if (stored.size > MAX_BRAND_BYTES) {
      await this.storage.delete(key).catch(() => undefined);
      throw new BadRequestException('La imagen pesa demasiado. Probá con una más chica.');
    }
    if (!stored.contentType.startsWith('image/')) {
      await this.storage.delete(key).catch(() => undefined);
      throw new BadRequestException('El archivo no es una imagen');
    }

    const field = FIELD[kind];
    const current = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { [field]: true } as any });
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { [field]: key } });
    const previous = (current as any)[field] as string | null;
    if (previous && previous !== key) await this.storage.delete(previous).catch(() => undefined);
    return this.result(tenantId);
  }

  /** Quita la imagen y borra el archivo. */
  async remove(tenantId: string, kind: BrandKind) {
    const field = FIELD[kind];
    const current = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { [field]: true } as any });
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { [field]: null } });
    const previous = (current as any)[field] as string | null;
    if (previous && this.storage.enabled) await this.storage.delete(previous).catch(() => undefined);
    return this.result(tenantId);
  }
}
