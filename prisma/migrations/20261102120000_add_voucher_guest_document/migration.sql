-- AlterTable
ALTER TABLE "hotel_vouchers" ADD COLUMN     "guestDocHash" TEXT,
ADD COLUMN     "guestDocHint" TEXT;

-- CreateIndex
CREATE INDEX "hotel_vouchers_hotelId_guestDocHash_idx" ON "hotel_vouchers"("hotelId", "guestDocHash");
