import { BadRequestException, Body, Controller, Delete, Headers, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsIn, IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { BRAND_KINDS, BrandImagesService, MAX_BRAND_BYTES, assertKind } from './brand-images.service';

// Lee el cuerpo como archivo, cortando apenas pasa el máximo
async function readBody(req: any, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new BadRequestException('La imagen pesa demasiado. Probá con una más chica.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class UploadUrlDto {
  @IsIn(BRAND_KINDS as unknown as string[]) kind: string;
  @IsString() @MaxLength(40) contentType: string;
}

class AttachDto {
  @IsIn(BRAND_KINDS as unknown as string[]) kind: string;
  @IsString() @MaxLength(200) key: string;
}

// Portada y fondo de la carta: solo el administrador
@Roles(Role.ADMIN)
@Controller('api/settings/brand-image')
export class BrandImagesController {
  constructor(private readonly images: BrandImagesService) {}

  @Post('upload-url')
  uploadUrl(@TenantId() tenantId: string, @Body() dto: UploadUrlDto) {
    return this.images.uploadUrl(tenantId, assertKind(dto.kind), dto.contentType);
  }

  // Alternativa a la subida directa: la imagen viaja a la API
  @Post('file/:kind')
  async file(@TenantId() tenantId: string, @Param('kind') kind: string, @Headers('content-type') contentType: string, @Req() req: any) {
    const data = await readBody(req, MAX_BRAND_BYTES);
    return this.images.uploadFile(tenantId, assertKind(kind), String(contentType ?? '').split(';')[0].trim(), data);
  }

  @Post('attach')
  attach(@TenantId() tenantId: string, @Body() dto: AttachDto) {
    return this.images.attach(tenantId, assertKind(dto.kind), dto.key);
  }

  @Delete(':kind')
  remove(@TenantId() tenantId: string, @Param('kind') kind: string) {
    return this.images.remove(tenantId, assertKind(kind));
  }
}
