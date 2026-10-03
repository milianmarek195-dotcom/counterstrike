-- Loadouts are visible on the player profile by default; owners can switch a loadout to private.
ALTER TABLE "loadouts" ALTER COLUMN "visibility" SET DEFAULT 'PUBLIC';
UPDATE "loadouts" SET "visibility" = 'PUBLIC' WHERE "visibility" = 'PRIVATE';
