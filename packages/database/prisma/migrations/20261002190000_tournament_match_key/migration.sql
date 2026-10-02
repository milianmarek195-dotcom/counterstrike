-- Bracket node key (U1-0, L3-1, GF-1, T-1) so the progression engine can address nodes unambiguously.
-- The table has no rows before the tournament feature ships, so adding a NOT NULL column is safe.
ALTER TABLE "tournament_matches" ADD COLUMN "key" VARCHAR(16) NOT NULL;

CREATE UNIQUE INDEX "tournament_matches_tournamentId_key_key" ON "tournament_matches"("tournamentId", "key");
