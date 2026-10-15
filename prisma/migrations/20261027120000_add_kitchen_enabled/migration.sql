-- La cocina (pantalla, estados de los pedidos) pasa a ser opcional: el negocio la habilita en "Mi negocio"
ALTER TABLE "tenants" ADD COLUMN "kitchenEnabled" BOOLEAN NOT NULL DEFAULT false;
