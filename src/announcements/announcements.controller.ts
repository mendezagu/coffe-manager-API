import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { PlatformUserGuard } from '../hotels/platform-auth';
import { AnnouncementsService, MAX_ANNOUNCEMENT_GIF_BYTES, MAX_BODY, MAX_IMAGES, MAX_TITLE } from './announcements.service';

class AnnouncementDto {
  @IsOptional() @IsString() @MaxLength(MAX_TITLE + 50) title?: string;
  @IsOptional() @IsString() @MaxLength(MAX_BODY + 500) body?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_IMAGES + 4) @IsString({ each: true }) @MaxLength(120, { each: true }) imageKeys?: string[];
  @IsOptional() @IsBoolean() important?: boolean;
  @IsOptional() @IsBoolean() showTag?: boolean;
}

// Lee el cuerpo como archivo. Si pasa el máximo, termina de recibir (y descarta) lo que falta antes de responder:
// cortar en seco hace que el navegador vea la conexión caída y nunca llegue a mostrar el mensaje de error.
const DRAIN_LIMIT = 60 * 1024 * 1024; // lo máximo que se recibe de más antes de cortar

async function readBody(req: any, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk);
    else if (size > max + DRAIN_LIMIT) break; // un envío enorme sí se corta
  }
  if (size > max) throw new BadRequestException('La imagen pesa demasiado. Probá con una más chica.');
  return Buffer.concat(chunks);
}

// Consola de plataforma: arma, publica y borra las novedades. @Public() solo saca la ruta del login de los locales;
// la protege PlatformUserGuard.
@Public()
@UseGuards(PlatformUserGuard)
@Controller('api/platform/announcements')
export class AnnouncementsPlatformController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list() {
    return this.announcements.listAll();
  }

  @Post()
  create(@Body() dto: AnnouncementDto) {
    return this.announcements.create(dto);
  }

  // Imagen de una novedad: llega a la API ya achicada (Content-Type: image/webp, jpeg o png; un GIF llega tal cual)
  @Post('images')
  async image(@Headers('content-type') contentType: string, @Req() req: any) {
    // Se lee hasta el máximo de un GIF; el servicio aplica el límite que corresponde a cada tipo
    const data = await readBody(req, MAX_ANNOUNCEMENT_GIF_BYTES);
    return this.announcements.uploadImage(String(contentType ?? '').split(';')[0].trim(), data);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: AnnouncementDto) {
    return this.announcements.update(id, dto);
  }

  @Patch(':id/publish')
  publish(@Param('id') id: string) {
    return this.announcements.publish(id);
  }

  @Patch(':id/unpublish')
  unpublish(@Param('id') id: string) {
    return this.announcements.unpublish(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.announcements.remove(id);
  }
}

// App de los locales: solo el administrador de cada local ve las novedades
@Roles(Role.ADMIN)
@Controller('api/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  list(@Req() req: any) {
    return this.announcements.listFor(req.user.id);
  }

  @Get('unread')
  unread(@Req() req: any) {
    return this.announcements.unreadFor(req.user.id);
  }

  @Post('read-all')
  readAll(@Req() req: any) {
    return this.announcements.markAllRead(req.user.id);
  }

  @Post(':id/read')
  read(@Req() req: any, @Param('id') id: string) {
    return this.announcements.markRead(req.user.id, id);
  }
}
