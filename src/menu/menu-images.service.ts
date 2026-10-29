import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mapMenuItem } from '../common/mappers';
import { MENU_INCLUDE } from './menu.service';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage';

export const MAX_IMAGE_BYTES = 400 * 1024; // la app achica la foto antes de subirla: pasarse de esto es un error o un abuso
const TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const NOT_CONFIGURED = 'La subida de fotos todavía no está disponible';

// Fotos de los platos. El navegador sube directo al almacenamiento con un permiso firmado y de corta duración;
// después le avisa a la API, que comprueba el archivo (existe, tamaño, tipo) antes de asociarlo al plato.
@Injectable()
export class MenuImagesService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  private async item(tenantId: string, id: string) {
    const item = await this.prisma.menuItem.findFirst({ where: { id, tenantId } });
    if (!item) throw new NotFoundException('Plato no encontrado');
    return item;
  }

  private assertEnabled() {
    if (!this.storage.enabled) throw new ServiceUnavailableException(NOT_CONFIGURED);
  }

  /** Paso 1: permiso para subir UNA foto de este plato. */
  async uploadUrl(tenantId: string, id: string, contentType: string) {
    this.assertEnabled();
    await this.item(tenantId, id);
    const ext = TYPES[contentType];
    if (!ext) throw new BadRequestException('La foto tiene que ser JPG, PNG o WebP');
    // La clave lleva el negocio y el plato: así se puede comprobar después que la foto es de este plato
    const key = `t/${tenantId}/menu/${id}-${randomBytes(8).toString('hex')}.${ext}`;
    return { key, uploadUrl: this.storage.presignPut(key, contentType), headers: { 'Content-Type': contentType }, maxBytes: MAX_IMAGE_BYTES };
  }

  /** Alternativa: la foto llega a la API (ya achicada, hasta 400 KB) y la API la guarda y la asocia al plato. */
  async uploadFile(tenantId: string, id: string, contentType: string, data: Buffer) {
    const slot = await this.uploadUrl(tenantId, id, contentType);
    if (data.length === 0) throw new BadRequestException('La foto está vacía');
    if (data.length > MAX_IMAGE_BYTES) throw new BadRequestException('La foto pesa demasiado. Probá con una más chica.');
    try {
      await this.storage.put(slot.key, data, contentType);
    } catch {
      throw new ServiceUnavailableException('No se pudo guardar la foto en este momento. Intentá de nuevo.');
    }
    return this.attach(tenantId, id, slot.key);
  }

  /** Paso 2: la foto ya está subida; se comprueba y queda asociada al plato (la anterior se borra). */
  async attach(tenantId: string, id: string, key: string) {
    this.assertEnabled();
    const item = await this.item(tenantId, id);
    // Solo se acepta una clave armada por el paso 1 para ESTE plato de ESTE negocio
    const valid = new RegExp(`^t/${tenantId}/menu/${id}-[0-9a-f]{16}\\.(webp|jpg|png)$`);
    if (!valid.test(key ?? '')) throw new BadRequestException('Foto no válida');

    const stored = await this.storage.head(key);
    if (!stored) throw new BadRequestException('No encontramos la foto subida. Probá de nuevo.');
    if (stored.size > MAX_IMAGE_BYTES) {
      await this.storage.delete(key).catch(() => undefined);
      throw new BadRequestException('La foto pesa demasiado. Probá con una más chica.');
    }
    if (!stored.contentType.startsWith('image/')) {
      await this.storage.delete(key).catch(() => undefined);
      throw new BadRequestException('El archivo no es una imagen');
    }

    const updated = await this.prisma.menuItem.update({ where: { id }, data: { imageKey: key }, include: MENU_INCLUDE });
    if (item.imageKey && item.imageKey !== key) await this.storage.delete(item.imageKey).catch(() => undefined);
    return mapMenuItem(updated);
  }

  /** Quita la foto del plato y borra el archivo. */
  async remove(tenantId: string, id: string) {
    const item = await this.item(tenantId, id);
    const updated = await this.prisma.menuItem.update({ where: { id }, data: { imageKey: null }, include: MENU_INCLUDE });
    if (item.imageKey && this.storage.enabled) await this.storage.delete(item.imageKey).catch(() => undefined);
    return mapMenuItem(updated);
  }
}
