import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { OnboardingService } from './onboarding.service';

class ApplyTemplateDto {
  @IsString() key!: string;
}

class CreateTablesDto {
  @IsInt() @Min(1) @Max(100) count!: number;
}

@Roles(Role.ADMIN)
@Controller('api/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('status')
  status(@TenantId() tenantId: string) {
    return this.onboarding.status(tenantId);
  }

  @Post('template')
  applyTemplate(@TenantId() tenantId: string, @Body() dto: ApplyTemplateDto) {
    return this.onboarding.applyTemplate(tenantId, dto.key);
  }

  @Delete('template')
  removeTemplate(@TenantId() tenantId: string) {
    return this.onboarding.removeTemplate(tenantId);
  }

  @Post('tables')
  createTables(@TenantId() tenantId: string, @Body() dto: CreateTablesDto) {
    return this.onboarding.createTables(tenantId, dto.count);
  }
}
