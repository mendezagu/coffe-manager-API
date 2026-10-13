import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  // 1 MB: alcanza para el logo del negocio (que el frontend achica antes de enviarlo)
  app.use(json({ limit: '1mb' }));

  // Detrás del proxy del hosting, req.ip tiene que ser la IP real del cliente (la usan los límites del pedido por QR)
  app.set('trust proxy', 1);

  // Orígenes permitidos separados por coma (ej: https://miapp.com,http://localhost:4200).
  // Sin CORS_ORIGINS se mantiene el comportamiento anterior (abierto) para no romper el desarrollo.
  const origins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors(origins?.length ? { origin: origins } : undefined);

  // Valida los DTOs con class-validator; ignora campos que el DTO no declara.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));

  // Puerto desde las variables de entorno
  const port = process.env.PORT || 3000;

  await app.listen(port);
  console.log(`Servidor corriendo en el puerto ${port}`);
}
bootstrap();
