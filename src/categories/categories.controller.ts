import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { Destination, Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { CategoriesService } from './categories.service';

class CreateCategoryDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsEnum(Destination) destination?: Destination;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsEnum(Destination) destination?: Destination;
}

@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  // Las ve todo el personal: el mozo las usa para filtrar el menú
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.categories.findAll(tenantId);
  }

  // Debe ir antes de ':id' para que "reorder" no se interprete como un id
  @Roles(Role.ADMIN)
  @Put('reorder')
  reorder(@TenantId() tenantId: string, @Body() body: { ids: unknown }) {
    return this.categories.reorder(tenantId, body?.ids);
  }

  @Roles(Role.ADMIN)
  @Post()
  create(@TenantId() tenantId: string, @Body() dto: CreateCategoryDto) {
    return this.categories.create(tenantId, dto);
  }

  @Roles(Role.ADMIN)
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(tenantId, id, dto);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.categories.remove(tenantId, id);
  }
}
