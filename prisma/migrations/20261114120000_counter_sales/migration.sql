-- AlterTable
ALTER TABLE "sales" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'mesa',
ADD COLUMN "takeaway" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "menu_items" ADD COLUMN "isFavorite" BOOLEAN NOT NULL DEFAULT false;
