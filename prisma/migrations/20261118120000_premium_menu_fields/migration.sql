-- Carta premium: descripción, etiqueta y "destacado" en cada plato; subtítulo, texto y formato en cada categoría
ALTER TABLE "menu_items" ADD COLUMN "description" TEXT,
ADD COLUMN "badge" TEXT,
ADD COLUMN "badgeColor" TEXT NOT NULL DEFAULT 'terracotta',
ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "categories" ADD COLUMN "subtitle" TEXT,
ADD COLUMN "tagline" TEXT,
ADD COLUMN "layout" TEXT NOT NULL DEFAULT 'grid';
