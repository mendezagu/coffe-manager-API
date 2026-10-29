import { BadRequestException, Body, Controller, Delete, Headers, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { MAX_IMAGE_BYTES, MenuImagesService } from './menu-images.service';

// Lee el cuerpo de la petición como archivo, cortando apenas pasa el máximo (no se acepta más que una foto chica)
async function readBody(req: any, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new BadRequestException('La foto pesa demasiado. Probá con una más chica.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class UploadUrlDto {
  @IsString() @MaxLength(40) contentType: string;
}

class AttachDto {
  @IsString() @MaxLength(200) key: string;
}

// Foto de un plato: solo el administrador
@Roles(Role.ADMIN)
@Controller('api/menu')
export class MenuImagesController {
  constructor(private readonly images: MenuImagesService) {}

  @Post(':id/image/upload-url')
  uploadUrl(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UploadUrlDto) {
    return this.images.uploadUrl(tenantId, id, dto.contentType);
  }

  // Alternativa a la subida directa: la foto viaja a la API (Content-Type: image/webp, jpeg o png) y la API la guarda
  @Post(':id/image/file')
  async file(@TenantId() tenantId: string, @Param('id') id: string, @Headers('content-type') contentType: string, @Req() req: any) {
    const data = await readBody(req, MAX_IMAGE_BYTES);
    return this.images.uploadFile(tenantId, id, String(contentType ?? '').split(';')[0].trim(), data);
  }

  @Post(':id/image')
  attach(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: AttachDto) {
    return this.images.attach(tenantId, id, dto.key);
  }

  @Delete(':id/image')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.images.remove(tenantId, id);
  }
}
