-- Asistente de primeros pasos. Los negocios que ya existían no lo ven (arrancan en true);
-- los que se creen de ahora en más sí (el valor por defecto queda en false).
ALTER TABLE "tenants" ADD COLUMN "onboardingDone" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ALTER COLUMN "onboardingDone" SET DEFAULT false;

-- Marca de lo que viene de la plantilla de ejemplo, para poder borrarlo de una vez
ALTER TABLE "menu_items" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "categories" ADD COLUMN "isExample" BOOLEAN NOT NULL DEFAULT false;
