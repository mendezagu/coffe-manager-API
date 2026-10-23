import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { UsersService } from './users.service';

class CreateUserDto {
  // Usuario con el que entra al local: letras, números y . _ - @ + (de 3 a 60). Puede ser un email.
  @Matches(/^[A-Za-z0-9._@+-]{3,60}$/, { message: 'El usuario puede tener letras, números y . _ - @ + (de 3 a 60 caracteres, sin espacios)' })
  email: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(Role)
  role: Role;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MinLength(8) password?: string;
}

@Roles(Role.ADMIN)
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  findAll(@TenantId() tenantId: string) {
    return this.users.findAll(tenantId);
  }

  @Post()
  create(@TenantId() tenantId: string, @Body() dto: CreateUserDto) {
    return this.users.create(tenantId, dto);
  }

  @Put(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: any) {
    return this.users.update(tenantId, id, dto, req.user.id);
  }

  @Delete(':id')
  remove(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any) {
    return this.users.remove(tenantId, id, req.user.id);
  }
}
