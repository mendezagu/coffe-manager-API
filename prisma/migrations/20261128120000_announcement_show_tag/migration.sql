-- Novedades: la etiqueta "Importante" pasa a ser opcional (por defecto se sigue mostrando)
ALTER TABLE "announcements" ADD COLUMN "showTag" BOOLEAN NOT NULL DEFAULT true;
