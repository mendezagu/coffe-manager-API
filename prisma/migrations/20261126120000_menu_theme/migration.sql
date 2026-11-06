-- Estilo de la carta del cliente: clara u oscura
ALTER TABLE "tenants" ADD COLUMN "menuTheme" TEXT NOT NULL DEFAULT 'light';
