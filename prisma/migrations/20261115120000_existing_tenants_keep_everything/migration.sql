-- Planes: Esencial (basic), Pro (pro) y Beneficios (benefits).
-- Los negocios que ya existen tenían todas las funciones: pasan a "benefits" (que las incluye todas) para que nada
-- deje de andar al publicar. El plan de cada uno se cambia después desde la Consola.
UPDATE "tenants" SET "plan" = 'benefits' WHERE "plan" = 'pro';
