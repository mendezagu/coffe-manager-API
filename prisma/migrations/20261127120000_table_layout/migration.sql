-- Plano del salón: lugar de cada mesa, en % del ancho y del alto (null = todavía sin ubicar)
ALTER TABLE "tables" ADD COLUMN "layoutX" DOUBLE PRECISION,
ADD COLUMN "layoutY" DOUBLE PRECISION;
