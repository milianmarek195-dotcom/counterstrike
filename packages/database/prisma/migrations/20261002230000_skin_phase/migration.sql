-- Doppler-type finishes share a name; the phase tells them apart (Phase 1-4, Ruby, Sapphire, Black Pearl, Emerald).
ALTER TABLE "skins" ADD COLUMN "phase" VARCHAR(32);
