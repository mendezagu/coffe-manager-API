-- Código de ingreso de cada local: se arma con el nombre (sin tildes ni símbolos, con guiones) y, si se repite, se le suma un número.
ALTER TABLE "tenants" ADD COLUMN "loginCode" TEXT;

WITH base AS (
  SELECT
    id,
    "createdAt",
    COALESCE(
      NULLIF(
        left(trim(both '-' from regexp_replace(translate(lower("name"), 'áéíóúüñàèìòù', 'aeiouunaeiou'), '[^a-z0-9]+', '-', 'g')), 40),
        ''
      ),
      'local'
    ) AS slug
  FROM "tenants"
), ranked AS (
  SELECT id, slug, row_number() OVER (PARTITION BY slug ORDER BY "createdAt", id) AS rn FROM base
)
UPDATE "tenants" t
SET "loginCode" = CASE WHEN r.rn = 1 THEN r.slug ELSE r.slug || '-' || r.rn END
FROM ranked r
WHERE t.id = r.id;

ALTER TABLE "tenants" ALTER COLUMN "loginCode" SET NOT NULL;
CREATE UNIQUE INDEX "tenants_loginCode_key" ON "tenants"("loginCode");

-- El usuario ya no es único en toda la plataforma, sino dentro de cada local.
DROP INDEX "users_email_key";
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");
