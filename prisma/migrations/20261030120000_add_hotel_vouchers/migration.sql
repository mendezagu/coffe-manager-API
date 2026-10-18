-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('ISSUED', 'REDEEMED', 'CANCELLED');

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "hotelId" TEXT,
ADD COLUMN     "voucherId" TEXT;

-- CreateTable
CREATE TABLE "hotels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "accessCode" TEXT NOT NULL,
    "contact" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "voucherValidDays" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hotel_partners" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "discountPct" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "hotel_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hotel_vouchers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "discountPct" DOUBLE PRECISION NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'ISSUED',
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "hotel_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hotels_slug_key" ON "hotels"("slug");

-- CreateIndex
CREATE INDEX "hotel_partners_tenantId_idx" ON "hotel_partners"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "hotel_partners_hotelId_tenantId_key" ON "hotel_partners"("hotelId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "hotel_vouchers_code_key" ON "hotel_vouchers"("code");

-- CreateIndex
CREATE INDEX "hotel_vouchers_hotelId_status_idx" ON "hotel_vouchers"("hotelId", "status");

-- CreateIndex
CREATE INDEX "hotel_vouchers_tenantId_status_idx" ON "hotel_vouchers"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_voucherId_key" ON "sales"("voucherId");

-- CreateIndex
CREATE INDEX "sales_hotelId_idx" ON "sales"("hotelId");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "hotel_vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_partners" ADD CONSTRAINT "hotel_partners_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_partners" ADD CONSTRAINT "hotel_partners_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_vouchers" ADD CONSTRAINT "hotel_vouchers_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_vouchers" ADD CONSTRAINT "hotel_vouchers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

