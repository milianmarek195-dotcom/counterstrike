-- AlterTable
ALTER TABLE "match_players" ADD COLUMN     "isCaptain" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "vetoConfig" JSONB;
