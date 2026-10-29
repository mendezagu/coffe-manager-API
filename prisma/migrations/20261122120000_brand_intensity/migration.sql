-- Intensidad de la portada y del fondo de la carta (null = automática)
ALTER TABLE "tenants" ADD COLUMN "coverIntensity" INTEGER;
ALTER TABLE "tenants" ADD COLUMN "backgroundIntensity" INTEGER;
