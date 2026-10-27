import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ModifierSelection, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { ModifiersService } from './modifiers.service';
import { RequiresFeature } from '../plans/feature.guard';

class OptionDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsNumber() priceDelta?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class CreateGroupDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsEnum(ModifierSelection) selection?: ModifierSelection;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OptionDto) options: OptionDto[];
}

class UpdateGroupDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsEnum(ModifierSelection) selection?: ModifierSelection;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => OptionDto) options?: OptionDto[];
}

class ApplyDto {
  @IsString() categoryId: string;
}

@Controller('api/modifiers')
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  // Los ve todo el personal que arma pedidos: el mozo elige las opciones al agregar un plato
  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.modifiers.findAll(tenantId);
  }

  // Debe ir antes de ':id' para que "reorder" no se interprete como un id
  @Roles(Role.ADMIN)
  @RequiresFeature('modifiers')
  @Put('reorder')
  reorder(@TenantId() tenantId: string, @Body() body: { ids: unknown }) {
    return this.modifiers.reorder(tenantId, body?.ids);
  }

  @Roles(Role.ADMIN)
  @RequiresFeature('modifiers')
  @Post()
  create(@TenantId() tenantId: string, @Body() dto: CreateGroupDto) {
    return this.modifiers.create(tenantId, dto);
  }

  @Roles(Role.ADMIN)
  @RequiresFeature('modifiers')
  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.modifiers.update(tenantId, id, dto);
  }

  @Roles(Role.ADMIN)
  @RequiresFeature('modifiers')
  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.modifiers.remove(tenantId, id);
  }

  // Ofrecer este modificador en todos los platos de una categoría
  @Roles(Role.ADMIN)
  @RequiresFeature('modifiers')
  @Post(':id/apply-to-category')
  applyToCategory(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: ApplyDto) {
    return this.modifiers.applyToCategory(tenantId, id, dto.categoryId);
  }
}
