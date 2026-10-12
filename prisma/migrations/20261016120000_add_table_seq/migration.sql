-- AlterTable: orden fijo de mesas. Las filas existentes reciben su número en el orden
-- en que están hoy, y las nuevas siguen la secuencia.
ALTER TABLE "tables" ADD COLUMN "seq" SERIAL NOT NULL;
