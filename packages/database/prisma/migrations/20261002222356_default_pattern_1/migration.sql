-- Default pattern is 1 unless the player chose another.
ALTER TABLE "inventory_items" ALTER COLUMN "paintSeed" SET DEFAULT 1;

-- Items saved with the old default pattern 0 get the new default 1 (the editor could not tell "not chosen" from 0).
UPDATE "inventory_items" SET "paintSeed" = 1 WHERE "paintSeed" = 0;
