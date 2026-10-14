-- El administrador decide si el cajero puede aplicar descuentos al cobrar
ALTER TABLE "tenants" ADD COLUMN "cashierDiscounts" BOOLEAN NOT NULL DEFAULT false;
