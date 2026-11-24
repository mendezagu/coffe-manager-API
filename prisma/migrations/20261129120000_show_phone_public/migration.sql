-- El teléfono del local en las páginas públicas pasa a ser opcional (por defecto no se muestra)
ALTER TABLE "tenants" ADD COLUMN "showPhonePublic" BOOLEAN NOT NULL DEFAULT false;
