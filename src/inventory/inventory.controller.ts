import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { UNITS } from './inventory.logic';
import { InventoryService } from './inventory.service';

class CreateItemDto {
  @IsString() @MaxLength(60) name: string;
  @IsOptional() @IsIn(UNITS as unknown as string[]) unit?: string;
  @IsOptional() @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @IsNumber() @Min(0) costPerUnit?: number;
  @IsOptional() @IsNumber() @Min(0) initialQuantity?: number;
}

class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsNumber() @Min(0) minStock?: number;
  @IsOptional() @IsNumber() @Min(0) costPerUnit?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

class PurchaseDto {
  @IsNumber() @Min(0.0001) quantity: number;
  @IsOptional() @IsNumber() @Min(0) unitCost?: number;
  @IsOptional() @IsString() @MaxLength(80) supplier?: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class WasteDto {
  @IsNumber() @Min(0.0001) quantity: number;
  @IsString() @MaxLength(200) reason: string;
}

class AdjustDto {
  @IsNumber() @Min(0) counted: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class CountLineDto {
  @IsString() stockItemId: string;
  @IsNumber() @Min(0) counted: number;
}

class CountDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CountLineDto) counts: CountLineDto[];
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class IngredientDto {
  @IsString() stockItemId: string;
  @IsNumber() @Min(0) quantity: number;
}

class RecipeDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => IngredientDto) ingredients: IngredientDto[];
}

class OptionLineDto {
  @IsString() stockItemId: string;
  @IsNumber() @Min(0) quantity: number;
  @IsOptional() @IsString() replacesStockItemId?: string | null;
}

class OptionIngredientsDto {
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => OptionLineDto) ingredients: OptionLineDto[];
}

class MovementsQuery {
  @IsOptional() @IsString() stockItemId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

// El inventario lo administra el dueño: lo ve y lo toca solo el administrador.
// (Lo que sí ven todos es la disponibilidad de cada plato, que viaja en el menú.)
@Roles(Role.ADMIN)
@Controller('api/inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('summary')
  summary(@TenantId() tenantId: string) {
    return this.inventory.summary(tenantId);
  }

  @Get('items')
  listItems(@TenantId() tenantId: string) {
    return this.inventory.listItems(tenantId);
  }

  @Post('items')
  createItem(@TenantId() tenantId: string, @Req() req: any, @Body() dto: CreateItemDto) {
    return this.inventory.createItem(tenantId, req.user.name, dto);
  }

  @Put('items/:id')
  updateItem(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateItemDto) {
    return this.inventory.updateItem(tenantId, id, dto);
  }

  @Delete('items/:id')
  removeItem(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.inventory.removeItem(tenantId, id);
  }

  @Post('items/:id/purchase')
  purchase(@TenantId() tenantId: string, @Req() req: any, @Param('id') id: string, @Body() dto: PurchaseDto) {
    return this.inventory.purchase(tenantId, req.user.name, id, dto);
  }

  @Post('items/:id/waste')
  waste(@TenantId() tenantId: string, @Req() req: any, @Param('id') id: string, @Body() dto: WasteDto) {
    return this.inventory.waste(tenantId, req.user.name, id, dto);
  }

  @Post('items/:id/adjust')
  adjust(@TenantId() tenantId: string, @Req() req: any, @Param('id') id: string, @Body() dto: AdjustDto) {
    return this.inventory.adjust(tenantId, req.user.name, id, dto);
  }

  @Post('count')
  count(@TenantId() tenantId: string, @Req() req: any, @Body() dto: CountDto) {
    return this.inventory.count(tenantId, req.user.name, dto);
  }

  @Get('movements')
  movements(@TenantId() tenantId: string, @Query() query: MovementsQuery) {
    return this.inventory.movements(tenantId, query);
  }

  @Get('recipes')
  recipes(@TenantId() tenantId: string) {
    return this.inventory.recipes(tenantId);
  }

  @Put('recipes/:menuItemId')
  setRecipe(@TenantId() tenantId: string, @Param('menuItemId') menuItemId: string, @Body() dto: RecipeDto) {
    return this.inventory.setRecipe(tenantId, menuItemId, dto.ingredients);
  }

  @Get('options')
  options(@TenantId() tenantId: string) {
    return this.inventory.options(tenantId);
  }

  @Put('options/:optionId')
  setOptionIngredients(@TenantId() tenantId: string, @Param('optionId') optionId: string, @Body() dto: OptionIngredientsDto) {
    return this.inventory.setOptionIngredients(tenantId, optionId, dto.ingredients);
  }
}
