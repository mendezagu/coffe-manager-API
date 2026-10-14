-- Momento en que se abrió la mesa (primer pedido): sirve para medir la permanencia
ALTER TABLE "tables" ADD COLUMN "openedAt" TIMESTAMP(3);
