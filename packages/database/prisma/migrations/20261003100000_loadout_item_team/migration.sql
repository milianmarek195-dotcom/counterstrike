-- A loadout item can be equipped for T, for CT or for both sides, so one weapon can carry two different skins.
CREATE TYPE "LoadoutTeam" AS ENUM ('BOTH', 'T', 'CT');

ALTER TABLE "loadout_items" ADD COLUMN "team" "LoadoutTeam" NOT NULL DEFAULT 'BOTH';

DROP INDEX "loadout_items_loadoutId_weaponDefIndex_key";
CREATE UNIQUE INDEX "loadout_items_loadoutId_weaponDefIndex_team_key" ON "loadout_items"("loadoutId", "weaponDefIndex", "team");
