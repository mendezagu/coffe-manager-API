-- Eliminar ítems: el permiso pasa de uno solo ("personal") a uno para mozos y otro para cajeros
ALTER TABLE "tenants"
  ADD COLUMN "waiterCanRemoveItems" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cashierCanRemoveItems" BOOLEAN NOT NULL DEFAULT false;

-- Quien ya lo había activado conserva el permiso para los dos roles
UPDATE "tenants" SET "waiterCanRemoveItems" = "staffCanRemoveItems", "cashierCanRemoveItems" = "staffCanRemoveItems";

ALTER TABLE "tenants" DROP COLUMN "staffCanRemoveItems";
