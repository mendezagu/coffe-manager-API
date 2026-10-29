-- Platos que se pueden ocultar de la carta online y del pedido por QR
ALTER TABLE "menu_items" ADD COLUMN "visibleInMenu" BOOLEAN NOT NULL DEFAULT true;
