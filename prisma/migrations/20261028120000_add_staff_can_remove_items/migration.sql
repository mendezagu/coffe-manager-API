-- El administrador decide si mozos y cajeros pueden eliminar ítems de una orden
ALTER TABLE "tenants" ADD COLUMN "staffCanRemoveItems" BOOLEAN NOT NULL DEFAULT false;
