-- AlterTable
ALTER TABLE "sectors" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- Los sectores existentes conservan el orden alfabético que se veía hasta ahora
UPDATE "sectors" SET "position" = ranked.rn
FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "name") - 1 AS rn FROM "sectors") AS ranked
WHERE "sectors"."id" = ranked."id";
