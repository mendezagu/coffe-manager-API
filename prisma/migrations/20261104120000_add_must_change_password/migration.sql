-- Los usuarios que ya existían no tienen que cambiar nada: la marca arranca en false.
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
