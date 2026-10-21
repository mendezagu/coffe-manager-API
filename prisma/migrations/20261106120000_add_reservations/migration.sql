-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'ARRIVED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('WEB', 'MANUAL', 'HOTEL');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'CONTACTED', 'BOOKED', 'CANCELLED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "reservationAdvanceDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "reservationCapacity" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "reservationCloseMin" INTEGER NOT NULL DEFAULT 1380,
ADD COLUMN     "reservationDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
ADD COLUMN     "reservationDurationMin" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "reservationMaxParty" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "reservationNoticeMin" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "reservationOpenMin" INTEGER NOT NULL DEFAULT 720,
ADD COLUMN     "reservationSlotMin" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "reservationSlug" TEXT,
ADD COLUMN     "reservationsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startMin" INTEGER NOT NULL,
    "partySize" INTEGER NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestPhone" TEXT NOT NULL,
    "guestEmail" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "source" "ReservationSource" NOT NULL DEFAULT 'WEB',
    "code" TEXT NOT NULL,
    "tableId" TEXT,
    "hotelId" TEXT,
    "voucherId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "fromMin" INTEGER NOT NULL,
    "toMin" INTEGER NOT NULL,
    "partySize" INTEGER NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestPhone" TEXT NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "hotelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservations_voucherId_key" ON "reservations"("voucherId");

-- CreateIndex
CREATE INDEX "reservations_tenantId_date_idx" ON "reservations"("tenantId", "date");

-- CreateIndex
CREATE INDEX "reservations_tenantId_guestPhone_idx" ON "reservations"("tenantId", "guestPhone");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_tenantId_code_key" ON "reservations"("tenantId", "code");

-- CreateIndex
CREATE INDEX "waitlist_entries_tenantId_date_status_idx" ON "waitlist_entries"("tenantId", "date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_reservationSlug_key" ON "tenants"("reservationSlug");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "hotel_vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

