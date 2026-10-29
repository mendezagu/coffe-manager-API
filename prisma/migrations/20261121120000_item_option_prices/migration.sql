-- Precio propio de una opción (ej: tamaño) en cada plato
CREATE TABLE "menu_item_option_prices" (
    "menuItemId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "menu_item_option_prices_pkey" PRIMARY KEY ("menuItemId", "optionId")
);

CREATE INDEX "menu_item_option_prices_optionId_idx" ON "menu_item_option_prices"("optionId");

ALTER TABLE "menu_item_option_prices" ADD CONSTRAINT "menu_item_option_prices_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_option_prices" ADD CONSTRAINT "menu_item_option_prices_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "modifier_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
