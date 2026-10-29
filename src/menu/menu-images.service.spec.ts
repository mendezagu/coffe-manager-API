import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService, StoredObject } from '../storage/object-storage';
import { MAX_IMAGE_BYTES, MenuImagesService } from './menu-images.service';

// Corre contra una base Postgres real y separada (coffee_manager_test). El almacenamiento (R2) se reemplaza por uno falso.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

class FakeStorage {
  enabled = true;
  files = new Map<string, StoredObject>();
  deleted: string[] = [];
  presignPut(key: string) {
    return `https://subida.falsa/${key}?firma=ok`;
  }
  async put(key: string, body: Buffer, contentType: string) {
    if (this.failPut) throw new Error('sin conexión');
    this.files.set(key, { size: body.length, contentType });
  }
  failPut = false;
  async head(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.files.delete(key);
  }
}

describe('Fotos de los platos', () => {
  let prisma: PrismaService;
  let storage: FakeStorage;
  let images: MenuImagesService;
  let tenantId: string;
  let otherTenantId: string;
  let itemId: string;
  let otherItemId: string;
  let sibling: string;
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
    tenantId = (await prisma.tenant.create({ data: { name: 'A', requireOpenRegister: false } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { name: 'B', requireOpenRegister: false } })).id;
    itemId = (await prisma.menuItem.create({ data: { tenantId, name: 'Café', price: 1000 } })).id;
    sibling = (await prisma.menuItem.create({ data: { tenantId, name: 'Té', price: 900 } })).id;
    otherItemId = (await prisma.menuItem.create({ data: { tenantId: otherTenantId, name: 'Ajeno', price: 1 } })).id;
    storage = new FakeStorage();
    images = new MenuImagesService(prisma, storage as unknown as ObjectStorageService);
  });

  const upload = async (id = itemId, size = 50_000, contentType = 'image/webp') => {
    const { key } = await images.uploadUrl(tenantId, id, contentType);
    storage.files.set(key, { size, contentType });
    return key;
  };

  it('da un permiso de subida con la clave del negocio y del plato', async () => {
    const r = await images.uploadUrl(tenantId, itemId, 'image/webp');
    expect(r.key).toMatch(new RegExp(`^t/${tenantId}/menu/${itemId}-[0-9a-f]{16}\\.webp$`));
    expect(r.uploadUrl).toContain(r.key);
    expect(r.maxBytes).toBe(MAX_IMAGE_BYTES);
  });

  it('rechaza tipos que no son foto, platos de otro negocio y el almacenamiento sin configurar', async () => {
    await expect(images.uploadUrl(tenantId, itemId, 'application/pdf')).rejects.toThrow(BadRequestException);
    await expect(images.uploadUrl(tenantId, itemId, 'image/svg+xml')).rejects.toThrow(BadRequestException);
    await expect(images.uploadUrl(tenantId, otherItemId, 'image/webp')).rejects.toThrow(NotFoundException);
    storage.enabled = false;
    await expect(images.uploadUrl(tenantId, itemId, 'image/webp')).rejects.toThrow(ServiceUnavailableException);
  });

  it('al confirmar, la foto queda en el plato y se muestra con la dirección pública', async () => {
    const key = await upload();
    const item = await images.attach(tenantId, itemId, key);
    expect(item.imageUrl).toBe(`https://fotos.ejemplo.app/${key}`);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } })).imageKey).toBe(key);
  });

  it('cambiar la foto borra la anterior', async () => {
    const first = await upload();
    await images.attach(tenantId, itemId, first);
    const second = await upload();
    await images.attach(tenantId, itemId, second);
    expect(storage.deleted).toEqual([first]);
  });

  it('no acepta una clave inventada, de otro plato ni de otro negocio', async () => {
    const mine = await upload(itemId);
    await expect(images.attach(tenantId, sibling, mine)).rejects.toThrow('Foto no válida'); // clave de otro plato
    await expect(images.attach(otherTenantId, itemId, mine)).rejects.toThrow(NotFoundException); // plato de otro negocio
    await expect(images.attach(tenantId, itemId, 't/otro/menu/x.webp')).rejects.toThrow('Foto no válida');
    await expect(images.attach(tenantId, itemId, `t/${tenantId}/menu/${itemId}-../../secreto.webp`)).rejects.toThrow('Foto no válida');
  });

  it('rechaza (y borra) una foto que no se subió, que pesa de más o que no es imagen', async () => {
    const { key: missing } = await images.uploadUrl(tenantId, itemId, 'image/webp');
    await expect(images.attach(tenantId, itemId, missing)).rejects.toThrow('No encontramos la foto');

    const big = await upload(itemId, MAX_IMAGE_BYTES + 1);
    await expect(images.attach(tenantId, itemId, big)).rejects.toThrow('pesa demasiado');
    expect(storage.deleted).toContain(big);

    // se pidió como WebP pero lo que quedó subido no es una imagen
    const notImage = await upload(itemId, 1000);
    storage.files.set(notImage, { size: 1000, contentType: 'text/html' });
    await expect(images.attach(tenantId, itemId, notImage)).rejects.toThrow('no es una imagen');
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } })).imageKey).toBeNull();
  });

  it('la foto puede llegar por la API: se guarda, se comprueba y queda en el plato', async () => {
    const item = await images.uploadFile(tenantId, itemId, 'image/webp', Buffer.alloc(40_000, 1));
    expect(item.imageUrl).toContain('https://fotos.ejemplo.app/t/' + tenantId + '/menu/' + itemId + '-');
    expect(item.imageUrl?.endsWith('.webp')).toBe(true);
    await expect(images.uploadFile(tenantId, itemId, 'image/webp', Buffer.alloc(MAX_IMAGE_BYTES + 1))).rejects.toThrow('pesa demasiado');
    await expect(images.uploadFile(tenantId, itemId, 'image/webp', Buffer.alloc(0))).rejects.toThrow('vacía');
    await expect(images.uploadFile(tenantId, itemId, 'text/html', Buffer.alloc(10))).rejects.toThrow(BadRequestException);
    await expect(images.uploadFile(tenantId, otherItemId, 'image/webp', Buffer.alloc(10))).rejects.toThrow(NotFoundException);
    storage.failPut = true;
    await expect(images.uploadFile(tenantId, itemId, 'image/webp', Buffer.alloc(10))).rejects.toThrow(ServiceUnavailableException);
  });

  it('quitar la foto limpia el plato y borra el archivo', async () => {
    const key = await upload();
    await images.attach(tenantId, itemId, key);
    const item = await images.remove(tenantId, itemId);
    expect(item.imageUrl).toBeNull();
    expect(storage.deleted).toContain(key);
    await expect(images.remove(tenantId, otherItemId)).rejects.toThrow(NotFoundException);
  });
});
