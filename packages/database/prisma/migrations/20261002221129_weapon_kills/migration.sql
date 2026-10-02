-- AlterTable
ALTER TABLE "match_player_map_stats" ADD COLUMN     "killsAk47" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsAwp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsPistol" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "match_players" ADD COLUMN     "killsAk47" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsAwp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsPistol" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "player_stats" ADD COLUMN     "killsAk47" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsAwp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "killsPistol" INTEGER NOT NULL DEFAULT 0;


-- Weapon-class kills are counters: never negative, and together never more than the player's kills.
ALTER TABLE "match_player_map_stats" ADD CONSTRAINT "match_player_map_stats_weapon_kills_check"
  CHECK ("killsAwp" >= 0 AND "killsAk47" >= 0 AND "killsPistol" >= 0 AND "killsAwp" + "killsAk47" + "killsPistol" <= "kills");
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_weapon_kills_check"
  CHECK ("killsAwp" >= 0 AND "killsAk47" >= 0 AND "killsPistol" >= 0 AND "killsAwp" + "killsAk47" + "killsPistol" <= "kills");
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_weapon_kills_check"
  CHECK ("killsAwp" >= 0 AND "killsAk47" >= 0 AND "killsPistol" >= 0 AND "killsAwp" + "killsAk47" + "killsPistol" <= "kills");
