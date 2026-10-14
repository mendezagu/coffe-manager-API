-- Para medir la permanencia: cuándo se abrió la mesa que cerró esta venta
ALTER TABLE "sales" ADD COLUMN "tableOpenedAt" TIMESTAMP(3);
