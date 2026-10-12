import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { ReportsService } from './reports.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class SalesReportDto {
  @IsOptional() @Matches(DAY, { message: 'from debe ser YYYY-MM-DD' }) from?: string;
  @IsOptional() @Matches(DAY, { message: 'to debe ser YYYY-MM-DD' }) to?: string;
  @IsOptional() @IsString() @MaxLength(64) tz?: string;
}

// Los reportes muestran la facturación del negocio: solo para el administrador.
@Roles(Role.ADMIN)
@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  sales(@TenantId() tenantId: string, @Query() query: SalesReportDto) {
    return this.reports.sales(tenantId, query);
  }
}
