-- AlterEnum
ALTER TYPE "MatchStatus" ADD VALUE 'MAP_FORCED';

-- DropForeignKey
ALTER TABLE "loadout_item_stickers" DROP CONSTRAINT "loadout_item_stickers_itemId_fkey";

-- DropForeignKey
ALTER TABLE "loadout_item_stickers" DROP CONSTRAINT "loadout_item_stickers_stickerId_fkey";

-- DropForeignKey
ALTER TABLE "loadout_items" DROP CONSTRAINT "loadout_items_skinId_fkey";

-- DropForeignKey
ALTER TABLE "match_players" DROP CONSTRAINT "match_players_matchTeamId_fkey";

-- DropIndex
DROP INDEX "loadout_items_skinId_idx";

-- AlterTable
ALTER TABLE "loadout_items" DROP COLUMN "floatValue",
DROP COLUMN "nameTag",
DROP COLUMN "paintSeed",
DROP COLUMN "skinId",
DROP COLUMN "slot",
DROP COLUMN "souvenir",
DROP COLUMN "statTrak",
DROP COLUMN "statTrakCount",
ADD COLUMN     "inventoryItemId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "match_players" DROP COLUMN "readyAt",
ALTER COLUMN "matchTeamId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "match_teams" ADD COLUMN     "maxPlayers" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "matches" DROP COLUMN "readyCheckStartedAt",
DROP COLUMN "readyDeadline",
ADD COLUMN     "controllerId" UUID;

-- DropTable
DROP TABLE "loadout_item_stickers";

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "slot" "LoadoutSlot" NOT NULL,
    "weaponDefIndex" INTEGER NOT NULL,
    "skinId" UUID,
    "paintSeed" INTEGER NOT NULL DEFAULT 0,
    "floatValue" DOUBLE PRECISION NOT NULL DEFAULT 0.001,
    "statTrak" BOOLEAN NOT NULL DEFAULT false,
    "statTrakCount" INTEGER NOT NULL DEFAULT 0,
    "souvenir" BOOLEAN NOT NULL DEFAULT false,
    "nameTag" VARCHAR(20),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_item_stickers" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "stickerId" UUID NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "wear" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetX" DOUBLE PRECISION,
    "offsetY" DOUBLE PRECISION,
    "rotation" DOUBLE PRECISION,
    "scale" DOUBLE PRECISION,

    CONSTRAINT "inventory_item_stickers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_items_ownerId_weaponDefIndex_idx" ON "inventory_items"("ownerId", "weaponDefIndex");

-- CreateIndex
CREATE INDEX "inventory_items_skinId_idx" ON "inventory_items"("skinId");

-- CreateIndex
CREATE INDEX "inventory_item_stickers_stickerId_idx" ON "inventory_item_stickers"("stickerId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_item_stickers_itemId_slotIndex_key" ON "inventory_item_stickers"("itemId", "slotIndex");

-- CreateIndex
CREATE INDEX "loadout_items_inventoryItemId_idx" ON "loadout_items"("inventoryItemId");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_controllerId_fkey" FOREIGN KEY ("controllerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_matchTeamId_fkey" FOREIGN KEY ("matchTeamId") REFERENCES "match_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_skinId_fkey" FOREIGN KEY ("skinId") REFERENCES "skins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_stickers" ADD CONSTRAINT "inventory_item_stickers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_item_stickers" ADD CONSTRAINT "inventory_item_stickers_stickerId_fkey" FOREIGN KEY ("stickerId") REFERENCES "stickers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout_items" ADD CONSTRAINT "loadout_items_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Virtual inventory: value ranges enforced by the database as the last line of defence.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_float_range" CHECK ("floatValue" >= 0 AND "floatValue" <= 1),
  ADD CONSTRAINT "inventory_items_seed_range" CHECK ("paintSeed" >= 0 AND "paintSeed" <= 1000),
  ADD CONSTRAINT "inventory_items_stattrak_nonneg" CHECK ("statTrakCount" >= 0),
  ADD CONSTRAINT "inventory_items_variant_exclusive" CHECK (NOT ("statTrak" AND "souvenir"));

ALTER TABLE "inventory_item_stickers"
  ADD CONSTRAINT "inventory_item_stickers_slot_range" CHECK ("slotIndex" >= 0 AND "slotIndex" <= 4),
  ADD CONSTRAINT "inventory_item_stickers_wear_range" CHECK ("wear" >= 0 AND "wear" <= 1);

-- Team sizes are free per side, but at least one player and a sane upper bound.
ALTER TABLE "match_teams" ADD CONSTRAINT "match_teams_max_players_range" CHECK ("maxPlayers" >= 1 AND "maxPlayers" <= 16);
