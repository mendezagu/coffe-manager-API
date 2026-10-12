-- CreateTable
CREATE TABLE "sectors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "sectors_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "tables" ADD COLUMN     "sectorId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sectors_name_key" ON "sectors"("name");

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "sectors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
