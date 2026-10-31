import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Announcement, Role } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService, publicImageUrl } from '../storage/object-storage';

export const MAX_TITLE = 120;
export const MAX_BODY = 4000;
export const MAX_IMAGES = 6;
export const MAX_ANNOUNCEMENT_IMAGE_BYTES = 500 * 1024; // la Consola achica la imagen antes de subirla
const TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const IMAGE_KEY = /^platform\/announcements\/[0-9a-f]{16}\.(webp|jpg|png)$/;
const PAGE = 30;

export interface AnnouncementInput {
  title?: string;
  body?: string;
  imageKeys?: string[];
  important?: boolean;
}

const clean = (text: unknown) => String(text ?? '').replace(/\r\n/g, '\n').trim();

// Cómo se ve una novedad en la app de los locales y en la Consola
export function mapAnnouncement(a: Announcement) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    images: a.imageKeys.map((key) => ({ key, url: publicImageUrl(key) })),
    important: a.important,
    status: a.status,
    publishedAt: a.publishedAt,
    createdAt: a.createdAt,
  };
}

// Novedades de la plataforma: las arma la Consola y las leen los administradores de cada local
@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService, private readonly storage: ObjectStorageService) {}

  // ---------- Consola de plataforma ----------

  async listAll() {
    const [items, admins] = await Promise.all([
      this.prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { reads: true } } } }),
      this.prisma.user.count({ where: { role: Role.ADMIN, active: true } }),
    ]);
    return items.map((a) => ({ ...mapAnnouncement(a), readCount: a._count.reads, totalAdmins: admins }));
  }

  private validate(input: AnnouncementInput, partial: boolean) {
    const data: { title?: string; body?: string; imageKeys?: string[]; important?: boolean } = {};
    if (!partial || input.title !== undefined) {
      const title = clean(input.title);
      if (!title) throw new BadRequestException('Poné un título');
      if (title.length > MAX_TITLE) throw new BadRequestException(`El título puede tener hasta ${MAX_TITLE} caracteres`);
      data.title = title;
    }
    if (!partial || input.body !== undefined) {
      const body = clean(input.body);
      if (!body) throw new BadRequestException('Escribí el texto de la novedad');
      if (body.length > MAX_BODY) throw new BadRequestException(`El texto puede tener hasta ${MAX_BODY} caracteres`);
      data.body = body;
    }
    if (input.imageKeys !== undefined) {
      const keys = [...new Set(Array.isArray(input.imageKeys) ? input.imageKeys : [])];
      if (keys.length > MAX_IMAGES) throw new BadRequestException(`Podés poner hasta ${MAX_IMAGES} imágenes`);
      if (keys.some((k) => !IMAGE_KEY.test(String(k)))) throw new BadRequestException('Hay una imagen que no es válida');
      data.imageKeys = keys;
    }
    if (input.important !== undefined) data.important = input.important === true;
    return data;
  }

  async create(input: AnnouncementInput) {
    const data = this.validate(input, false);
    const created = await this.prisma.announcement.create({ data: { title: data.title!, body: data.body!, imageKeys: data.imageKeys ?? [], important: data.important ?? false } });
    return mapAnnouncement(created);
  }

  async update(id: string, input: AnnouncementInput) {
    const current = await this.find(id);
    const data = this.validate(input, true);
    const updated = await this.prisma.announcement.update({ where: { id }, data });
    // las imágenes que se sacaron se borran del almacenamiento
    if (data.imageKeys) await this.deleteFiles(current.imageKeys.filter((k) => !data.imageKeys!.includes(k)));
    return mapAnnouncement(updated);
  }

  async publish(id: string) {
    const current = await this.find(id);
    if (current.status === 'published') return mapAnnouncement(current);
    const updated = await this.prisma.announcement.update({ where: { id }, data: { status: 'published', publishedAt: new Date() } });
    return mapAnnouncement(updated);
  }

  // Vuelve a borrador: deja de verse en los locales (lo que ya leyeron queda registrado)
  async unpublish(id: string) {
    await this.find(id);
    const updated = await this.prisma.announcement.update({ where: { id }, data: { status: 'draft', publishedAt: null } });
    return mapAnnouncement(updated);
  }

  async remove(id: string) {
    const current = await this.find(id);
    await this.prisma.announcement.delete({ where: { id } });
    await this.deleteFiles(current.imageKeys);
    return { message: 'Novedad eliminada' };
  }

  // Sube una imagen (ya achicada por la Consola) y devuelve su clave y su dirección
  async uploadImage(contentType: string, data: Buffer) {
    if (!this.storage.enabled) throw new ServiceUnavailableException('La subida de imágenes todavía no está disponible');
    const ext = TYPES[contentType];
    if (!ext) throw new BadRequestException('La imagen tiene que ser JPG, PNG o WebP');
    if (data.length === 0) throw new BadRequestException('La imagen está vacía');
    if (data.length > MAX_ANNOUNCEMENT_IMAGE_BYTES) throw new BadRequestException('La imagen pesa demasiado. Probá con una más chica.');
    const key = `platform/announcements/${randomBytes(8).toString('hex')}.${ext}`;
    try {
      await this.storage.put(key, data, contentType);
    } catch {
      throw new ServiceUnavailableException('No se pudo guardar la imagen en este momento. Intentá de nuevo.');
    }
    return { key, url: publicImageUrl(key) };
  }

  private async find(id: string) {
    const found = await this.prisma.announcement.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Novedad no encontrada');
    return found;
  }

  private async deleteFiles(keys: string[]) {
    if (!this.storage.enabled) return;
    await Promise.all(keys.map((k) => this.storage.delete(k).catch(() => undefined)));
  }

  // ---------- App de los locales (administradores) ----------

  // Las novedades publicadas, las más nuevas primero, con si ese usuario ya la leyó
  async listFor(userId: string) {
    const items = await this.prisma.announcement.findMany({
      where: { status: 'published' },
      orderBy: { publishedAt: 'desc' },
      take: PAGE,
      include: { reads: { where: { userId }, select: { userId: true } } },
    });
    return items.map((a) => ({ ...mapAnnouncement(a), read: a.reads.length > 0 }));
  }

  // Cuántas le faltan leer y, si hay una importante sin leer, cuál (para la ventana al entrar)
  async unreadFor(userId: string) {
    const where = { status: 'published', reads: { none: { userId } } };
    const [count, popup] = await Promise.all([
      this.prisma.announcement.count({ where }),
      this.prisma.announcement.findFirst({ where: { ...where, important: true }, orderBy: { publishedAt: 'desc' } }),
    ]);
    return { count, popup: popup ? mapAnnouncement(popup) : null };
  }

  async markRead(userId: string, id: string) {
    const found = await this.prisma.announcement.findFirst({ where: { id, status: 'published' } });
    if (!found) throw new NotFoundException('Novedad no encontrada');
    await this.prisma.announcementRead.upsert({ where: { announcementId_userId: { announcementId: id, userId } }, create: { announcementId: id, userId }, update: {} });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    const pending = await this.prisma.announcement.findMany({ where: { status: 'published', reads: { none: { userId } } }, select: { id: true } });
    if (pending.length) await this.prisma.announcementRead.createMany({ data: pending.map((p) => ({ announcementId: p.id, userId })), skipDuplicates: true });
    return { ok: true, marked: pending.length };
  }
}
