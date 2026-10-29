import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { ObjectStorageService, StoredObject } from '../storage/object-storage';
import { TablesService } from '../tables/tables.service';
import { BrandImagesService, MAX_BRAND_BYTES, assertKind } from './brand-images.service';
import { SettingsService } from './settings.service';

// Corre contra una base Postgres real y separada (coffee_manager_test). El almacenamiento (R2) se reemplaza por uno falso.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

class FakeStorage {
  enabled = true;
  files = new Map<string, StoredObject>();
  deleted: string[] = [];
  failPut = false;
  presignPut(key: string) {
    return `https://subida.falsa/${key}`;
  }
  async put(key: string, body: Buffer, contentType: string) {
    if (this.failPut) throw new Error('sin conexión');
    this.files.set(key, { size: body.length, contentType });
  }
  async head(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.files.delete(key);
  }
}

describe('Portada y fondo de la carta', () => {
  let prisma: PrismaService;
  let storage: FakeStorage;
  let images: BrandImagesService;
  let tenantId: string;
  let otherTenantId: string;
  const prevUrl = process.env.R2_PUBLIC_URL;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
    process.env.R2_PUBLIC_URL = 'https://fotos.ejemplo.app';
  });
  afterAll(async () => {
    process.env.R2_PUBLIC_URL = prevUrl;
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.tenant.deleteMany({});
    tenantId = (await prisma.tenant.create({ data: { name: 'Café Sol', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'Otro', requireOpenRegister: false } })).id;
    storage = new FakeStorage();
    images = new BrandImagesService(prisma, storage as unknown as ObjectStorageService);
  });

  it('solo existen la portada y el fondo', () => {
    expect(assertKind('cover')).toBe('cover');
    expect(assertKind('background')).toBe('background');
    expect(() => assertKind('logo')).toThrow(BadRequestException);
  });

  it('la clave lleva el negocio y el tipo; rechaza lo que no es imagen y el almacenamiento sin configurar', async () => {
    const r = await images.uploadUrl(tenantId, 'cover', 'image/webp');
    expect(r.key).toMatch(new RegExp(`^t/${tenantId}/brand/cover-[0-9a-f]{16}\\.webp$`));
    await expect(images.uploadUrl(tenantId, 'cover', 'application/pdf')).rejects.toThrow(BadRequestException);
    storage.enabled = false;
    await expect(images.uploadUrl(tenantId, 'cover', 'image/webp')).rejects.toThrow(ServiceUnavailableException);
  });

  it('por la API: queda guardada y se ve con la dirección pública; cambiarla borra la anterior', async () => {
    const first = await images.uploadFile(tenantId, 'background', 'image/webp', Buffer.alloc(50_000, 1));
    expect(first.backgroundImageUrl).toContain('https://fotos.ejemplo.app/t/' + tenantId + '/brand/background-');
    expect(first.coverImageUrl).toBeNull();
    await images.uploadFile(tenantId, 'background', 'image/webp', Buffer.alloc(40_000, 1));
    expect(storage.deleted).toHaveLength(1);
  });

  it('no acepta imágenes vacías, demasiado pesadas ni claves ajenas', async () => {
    await expect(images.uploadFile(tenantId, 'cover', 'image/webp', Buffer.alloc(0))).rejects.toThrow('vacía');
    await expect(images.uploadFile(tenantId, 'cover', 'image/webp', Buffer.alloc(MAX_BRAND_BYTES + 1))).rejects.toThrow('pesa demasiado');

    const slot = await images.uploadUrl(otherTenantId, 'cover', 'image/webp');
    storage.files.set(slot.key, { size: 100, contentType: 'image/webp' });
    await expect(images.attach(tenantId, 'cover', slot.key)).rejects.toThrow('Imagen no válida'); // clave de otro negocio
    const mine = await images.uploadUrl(tenantId, 'cover', 'image/webp');
    storage.files.set(mine.key, { size: 100, contentType: 'image/webp' });
    await expect(images.attach(tenantId, 'background', mine.key)).rejects.toThrow('Imagen no válida'); // tipo distinto
    storage.failPut = true;
    await expect(images.uploadFile(tenantId, 'cover', 'image/webp', Buffer.alloc(10))).rejects.toThrow(ServiceUnavailableException);
  });

  it('quitar la imagen la borra del local y del almacenamiento', async () => {
    await images.uploadFile(tenantId, 'cover', 'image/webp', Buffer.alloc(1000));
    const r = await images.remove(tenantId, 'cover');
    expect(r.coverImageUrl).toBeNull();
    expect(storage.deleted).toHaveLength(1);
  });

  it('la carta pública y los ajustes traen la portada y el fondo', async () => {
    await images.uploadFile(tenantId, 'cover', 'image/webp', Buffer.alloc(1000));
    await images.uploadFile(tenantId, 'background', 'image/webp', Buffer.alloc(1000));
    const settings = new SettingsService(prisma);
    const saved = await settings.update(tenantId, { menuPublicEnabled: true });
    expect(saved.coverImageUrl).toContain('/brand/cover-');
    expect(saved.backgroundImageUrl).toContain('/brand/background-');

    const carta = await new QrService(prisma, new TablesService(prisma)).publicCarta('cafe-sol', '10.7.0.1');
    expect(carta.business.coverUrl).toContain('/brand/cover-');
    expect(carta.business.backgroundUrl).toContain('/brand/background-');
    expect(JSON.stringify(carta)).not.toContain('ImageKey');
  });
});
