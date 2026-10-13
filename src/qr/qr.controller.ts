import { Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { TenantId } from '../auth/tenant.decorator';
import { QrService } from './qr.service';

const ID = /^[\w-]{1,64}$/;

class OrderLineDto {
  @IsString() @Matches(ID) menuItemId: string;
  @IsInt() @Min(1) @Max(30) quantity: number;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @Matches(ID, { each: true }) optionIds?: string[];
}

class CreateRequestDto {
  // Lo genera el celular y se guarda ahí: sirve para que cada cliente vea solo sus pedidos
  @IsString() @Matches(/^[\w-]{8,64}$/) clientId: string;
  @IsOptional() @IsString() @MaxLength(40) customerName?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => OrderLineDto) items: OrderLineDto[];
}

class ClientDto {
  @IsString() @Matches(/^[\w-]{8,64}$/) clientId: string;
}

class CallDto {
  @IsIn(['WAITER', 'BILL']) type: 'WAITER' | 'BILL';
}

class RejectDto {
  @IsOptional() @IsString() @MaxLength(140) reason?: string;
}

class ConfirmDto {
  @IsOptional() @IsString() @Matches(ID) waiterId?: string;
}

// La conexión del cliente (detrás del proxy del hosting, Express ya devuelve la IP real con `trust proxy`)
const ipOf = (req: any): string => String(req.ip ?? req.socket?.remoteAddress ?? 'desconocida');

// ---------------------------------------------------------------------------------------------
// Pantalla del cliente. Sin sesión: lo único que da acceso es el código secreto del QR de la mesa,
// y con él solo se puede ver la carta, enviar pedidos a ESA mesa y ver los propios.
// ---------------------------------------------------------------------------------------------
@Public()
@Controller('api/public/mesa')
export class QrPublicController {
  constructor(private readonly qr: QrService) {}

  @Get(':token')
  info(@Param('token') token: string, @Req() req: any, @Headers('x-table-pin') pin?: string) {
    return this.qr.info(token, ipOf(req), pin);
  }

  @Post(':token/orders')
  create(@Param('token') token: string, @Req() req: any, @Headers('x-table-pin') pin: string | undefined, @Body() dto: CreateRequestDto) {
    return this.qr.createRequest(token, ipOf(req), pin, dto);
  }

  @Post(':token/my-orders')
  mine(@Param('token') token: string, @Req() req: any, @Headers('x-table-pin') pin: string | undefined, @Body() dto: ClientDto) {
    return this.qr.clientOrders(token, ipOf(req), pin, dto.clientId);
  }

  @Post(':token/orders/:id/cancel')
  cancel(
    @Param('token') token: string,
    @Param('id') id: string,
    @Req() req: any,
    @Headers('x-table-pin') pin: string | undefined,
    @Body() dto: ClientDto,
  ) {
    return this.qr.cancelRequest(token, ipOf(req), pin, id, dto.clientId);
  }

  @Post(':token/calls')
  call(@Param('token') token: string, @Req() req: any, @Headers('x-table-pin') pin: string | undefined, @Body() dto: CallDto) {
    return this.qr.createCall(token, ipOf(req), pin, dto.type);
  }
}

// ---------------------------------------------------------------------------------------------
// Personal del local
// ---------------------------------------------------------------------------------------------
@Controller('api/qr')
export class QrController {
  constructor(private readonly qr: QrService) {}

  // Pedidos esperando confirmación y avisos abiertos (la app lo consulta cada pocos segundos)
  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Get('inbox')
  inbox(@TenantId() tenantId: string) {
    return this.qr.inbox(tenantId);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Post('requests/:id/confirm')
  confirm(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any, @Body() dto: ConfirmDto) {
    return this.qr.confirm(tenantId, id, { waiterId: dto.waiterId, actorName: req.user.name });
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Post('requests/:id/reject')
  reject(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any, @Body() dto: RejectDto) {
    return this.qr.reject(tenantId, id, dto.reason ?? '', req.user.name);
  }

  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Post('calls/:id/done')
  callDone(@TenantId() tenantId: string, @Param('id') id: string, @Req() req: any) {
    return this.qr.resolveCall(tenantId, id, req.user.name);
  }

  // Mesas con su código de mesa; el código secreto del QR solo lo ve el administrador
  @Roles(Role.ADMIN, Role.CASHIER, Role.WAITER)
  @Get('tables')
  tables(@TenantId() tenantId: string, @Req() req: any) {
    return this.qr.tablesView(tenantId, req.user.role === Role.ADMIN);
  }

  @Roles(Role.ADMIN)
  @Post('tables/generate')
  generate(@TenantId() tenantId: string) {
    return this.qr.generate(tenantId);
  }

  @Roles(Role.ADMIN)
  @Post('tables/:id/regenerate')
  regenerate(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.qr.regenerate(tenantId, id);
  }
}
