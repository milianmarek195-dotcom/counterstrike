CREATE TABLE "keychains" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(64),
    "defIndex" INTEGER NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "rarity" VARCHAR(48),
    "collection" VARCHAR(96),
    "imageUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "keychains_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "keychains_externalId_key" ON "keychains"("externalId");
CREATE UNIQUE INDEX "keychains_defIndex_key" ON "keychains"("defIndex");
ALTER TABLE "inventory_items" ADD COLUMN "keychainId" UUID;
ALTER TABLE "inventory_items" ADD COLUMN "keychainSeed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_keychainId_fkey" FOREIGN KEY ("keychainId") REFERENCES "keychains"("id") ON DELETE SET NULL ON UPDATE CASCADE;
