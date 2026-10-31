import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ObjectStorageService } from '../storage/object-storage';
import { AnnouncementsService } from './announcements.service';

// Corre contra una base Postgres real y separada (coffee_manager_test).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL as string;
if (!TEST_DATABASE_URL) {
  throw new Error('Definí TEST_DATABASE_URL (ej: postgresql://user:password@localhost:5432/coffee_manager_test?schema=public)');
}

describe('Novedades de la plataforma', () => {
  let prisma: PrismaService;
  let service: AnnouncementsService;
  let storage: { enabled: boolean; put: jest.Mock; delete: jest.Mock };
  let adminA: string;
  let adminB: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } }) as PrismaService;
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.announcement.deleteMany({});
    await prisma.tenant.deleteMany({});
    storage = { enabled: true, put: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) };
    service = new AnnouncementsService(prisma, storage as unknown as ObjectStorageService);
    const t1 = await prisma.tenant.create({ data: { name: 'Local A' } });
    const t2 = await prisma.tenant.create({ data: { name: 'Local B' } });
    const user = (tenantId: string, email: string) => prisma.user.create({ data: { tenantId, email, name: email, role: Role.ADMIN, passwordHash: 'x' } });
    adminA = (await user(t1.id, 'a@a.com')).id;
    adminB = (await user(t2.id, 'b@b.com')).id;
  });

  const draft = (extra: Record<string, unknown> = {}) => service.create({ title: 'Nuevo Mostrador', body: 'Ahora podés vender sin mesa.', ...extra });

  it('una novedad en borrador no la ve nadie; publicada la ven todos los administradores', async () => {
    const a = await draft();
    expect(a.status).toBe('draft');
    expect(await service.listFor(adminA)).toEqual([]);
    expect((await service.unreadFor(adminA)).count).toBe(0);

    await service.publish(a.id);
    expect((await service.listFor(adminA)).map((x) => x.title)).toEqual(['Nuevo Mostrador']);
    expect((await service.listFor(adminB)).length).toBe(1);
    expect((await service.unreadFor(adminB)).count).toBe(1);
  });

  it('leer es por usuario: lo que lee uno no se marca para el otro', async () => {
    const a = await draft();
    await service.publish(a.id);
    await service.markRead(adminA, a.id);
    expect((await service.unreadFor(adminA)).count).toBe(0);
    expect((await service.listFor(adminA))[0].read).toBe(true);
    expect((await service.unreadFor(adminB)).count).toBe(1);
    // leer dos veces no falla
    await expect(service.markRead(adminA, a.id)).resolves.toEqual({ ok: true });
  });

  it('marcar todas como leídas', async () => {
    for (const t of ['Uno', 'Dos', 'Tres']) await service.publish((await draft({ title: t })).id);
    expect((await service.unreadFor(adminA)).count).toBe(3);
    expect((await service.markAllRead(adminA)).marked).toBe(3);
    expect((await service.unreadFor(adminA)).count).toBe(0);
    expect((await service.markAllRead(adminA)).marked).toBe(0);
  });

  it('solo las importantes sin leer salen en la ventana de entrada', async () => {
    const normal = await draft({ title: 'Normal' });
    const important = await draft({ title: 'Importante', important: true });
    await service.publish(normal.id);
    await service.publish(important.id);
    const unread = await service.unreadFor(adminA);
    expect(unread.count).toBe(2);
    expect(unread.popup?.title).toBe('Importante');
    await service.markRead(adminA, important.id);
    expect((await service.unreadFor(adminA)).popup).toBeNull();
  });

  it('no se puede leer una novedad que no está publicada ni una que no existe', async () => {
    const a = await draft();
    await expect(service.markRead(adminA, a.id)).rejects.toThrow(NotFoundException);
    await expect(service.markRead(adminA, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(NotFoundException);
  });

  it('despublicar la saca de los locales y la Consola cuenta quién la leyó', async () => {
    const a = await draft();
    await service.publish(a.id);
    await service.markRead(adminA, a.id);
    const [row] = await service.listAll();
    expect(row).toMatchObject({ readCount: 1, totalAdmins: 2, status: 'published' });
    await service.unpublish(a.id);
    expect(await service.listFor(adminB)).toEqual([]);
  });

  it('valida título, texto e imágenes', async () => {
    await expect(service.create({ title: '  ', body: 'x' })).rejects.toThrow(BadRequestException);
    await expect(service.create({ title: 'x', body: '' })).rejects.toThrow(BadRequestException);
    await expect(service.create({ title: 'x'.repeat(121), body: 'x' })).rejects.toThrow(BadRequestException);
    await expect(service.create({ title: 'x', body: 'x'.repeat(4001) })).rejects.toThrow(BadRequestException);
    await expect(service.create({ title: 'x', body: 'x', imageKeys: ['t/otro-negocio/menu/foto.webp'] })).rejects.toThrow(BadRequestException);
    const keys = Array.from({ length: 7 }, (_, i) => `platform/announcements/${String(i).padStart(16, '0')}.webp`);
    await expect(service.create({ title: 'x', body: 'x', imageKeys: keys })).rejects.toThrow(BadRequestException);
  });

  it('sube imágenes con tipo y tamaño válidos; las que se sacan o se borran con la novedad se eliminan del almacenamiento', async () => {
    await expect(service.uploadImage('application/pdf', Buffer.from('x'))).rejects.toThrow(BadRequestException);
    await expect(service.uploadImage('image/webp', Buffer.alloc(0))).rejects.toThrow(BadRequestException);
    await expect(service.uploadImage('image/webp', Buffer.alloc(600 * 1024))).rejects.toThrow(BadRequestException);
    const one = await service.uploadImage('image/webp', Buffer.from('img1'));
    const two = await service.uploadImage('image/png', Buffer.from('img2'));
    expect(one.key).toMatch(/^platform\/announcements\/[0-9a-f]{16}\.webp$/);
    expect(storage.put).toHaveBeenCalledTimes(2);

    const a = await draft({ imageKeys: [one.key, two.key] });
    await service.update(a.id, { imageKeys: [one.key] });
    expect(storage.delete).toHaveBeenCalledWith(two.key);
    await service.remove(a.id);
    expect(storage.delete).toHaveBeenCalledWith(one.key);
    expect(await prisma.announcement.count()).toBe(0);
  });

  it('sin almacenamiento configurado no se pueden subir imágenes', async () => {
    storage.enabled = false;
    await expect(service.uploadImage('image/webp', Buffer.from('x'))).rejects.toThrow(ServiceUnavailableException);
  });

  it('editar cambia solo lo que viene', async () => {
    const a = await draft();
    const edited = await service.update(a.id, { title: 'Otro título' });
    expect(edited).toMatchObject({ title: 'Otro título', body: 'Ahora podés vender sin mesa.' });
    await expect(service.update('00000000-0000-0000-0000-000000000000', { title: 'x' })).rejects.toThrow(NotFoundException);
  });
});
