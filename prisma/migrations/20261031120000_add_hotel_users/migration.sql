-- CreateTable
CREATE TABLE "hotel_users" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hotel_users_email_key" ON "hotel_users"("email");

-- CreateIndex
CREATE INDEX "hotel_users_hotelId_idx" ON "hotel_users"("hotelId");

-- AddForeignKey
ALTER TABLE "hotel_users" ADD CONSTRAINT "hotel_users_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

