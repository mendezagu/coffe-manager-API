-- Carta online: dirección pública para ver el menú sin pedir ni código
ALTER TABLE "tenants" ADD COLUMN "menuPublicEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "menuSlug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_menuSlug_key" ON "tenants"("menuSlug");
