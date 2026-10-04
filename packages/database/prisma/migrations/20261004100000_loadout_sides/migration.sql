ALTER TABLE "loadouts" ADD COLUMN "activeT" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "loadouts" ADD COLUMN "activeCt" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "loadouts_one_active_t" ON "loadouts"("ownerId") WHERE "activeT";
CREATE UNIQUE INDEX "loadouts_one_active_ct" ON "loadouts"("ownerId") WHERE "activeCt";
