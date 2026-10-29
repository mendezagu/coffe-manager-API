-- Imagen de portada y de fondo de la carta (clave del archivo en el almacenamiento)
ALTER TABLE "tenants" ADD COLUMN "coverImageKey" TEXT,
ADD COLUMN "backgroundImageKey" TEXT;
