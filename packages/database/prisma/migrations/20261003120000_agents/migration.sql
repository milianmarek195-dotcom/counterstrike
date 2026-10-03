-- Agents (player models) are catalog entries of their own slot, bound to one side.
ALTER TYPE "LoadoutSlot" ADD VALUE 'AGENT';
ALTER TABLE "skins" ADD COLUMN "modelPath" TEXT;
ALTER TABLE "skins" ADD COLUMN "side" VARCHAR(2);
