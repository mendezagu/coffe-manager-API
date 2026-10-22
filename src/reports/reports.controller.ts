import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { ReportsService } from './reports.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

class LiveQueryDto {
  @IsOptional() @IsString() @MaxLength(64) tz?: string;
  // Cuándo se comenzó el turno actual (ISO): el resumen cuenta solo desde ahí
  @IsOptional() @IsISO8601() since?: string;
}

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

  // Resumen de hoy para el Inicio (ventas vs ayer y permanencia promedio de las mesas)
  @Get('live')
  live(@TenantId() tenantId: string, @Query() query: LiveQueryDto) {
    return this.reports.live(tenantId, query.tz, new Date(), query.since ? new Date(query.since) : undefined);
  }

  @Get('sales')
  sales(@TenantId() tenantId: string, @Query() query: SalesReportDto) {
    return this.reports.sales(tenantId, query);
  }
}
