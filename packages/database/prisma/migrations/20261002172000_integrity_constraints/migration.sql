-- Integrity rules Prisma cannot express in schema.prisma. Documented in docs/DATABASE.md.

-- Ranking: Elo never negative, peak never below current.
ALTER TABLE "player_ranks"
  ADD CONSTRAINT "player_ranks_elo_nonneg" CHECK ("elo" >= 0),
  ADD CONSTRAINT "player_ranks_peak_ge_elo" CHECK ("peakElo" >= "elo"),
  ADD CONSTRAINT "player_ranks_counts_nonneg" CHECK ("wins" >= 0 AND "losses" >= 0 AND "draws" >= 0 AND "matches" >= 0);

-- Skin system: float, seed, sticker slot and wear ranges are enforced by the database as the last line of defence.
ALTER TABLE "loadout_items"
  ADD CONSTRAINT "loadout_items_float_range" CHECK ("floatValue" >= 0 AND "floatValue" <= 1),
  ADD CONSTRAINT "loadout_items_seed_range" CHECK ("paintSeed" >= 0 AND "paintSeed" <= 1000),
  ADD CONSTRAINT "loadout_items_stattrak_nonneg" CHECK ("statTrakCount" >= 0),
  ADD CONSTRAINT "loadout_items_variant_exclusive" CHECK (NOT ("statTrak" AND "souvenir"));

ALTER TABLE "loadout_item_stickers"
  ADD CONSTRAINT "loadout_item_stickers_slot_range" CHECK ("slotIndex" >= 0 AND "slotIndex" <= 4),
  ADD CONSTRAINT "loadout_item_stickers_wear_range" CHECK ("wear" >= 0 AND "wear" <= 1);

ALTER TABLE "skins"
  ADD CONSTRAINT "skins_float_range" CHECK ("minFloat" >= 0 AND "maxFloat" <= 1 AND "minFloat" <= "maxFloat");

ALTER TABLE "skin_prices"
  ADD CONSTRAINT "skin_prices_price_nonneg" CHECK ("priceUsd" >= 0);

ALTER TABLE "skin_permissions"
  ADD CONSTRAINT "skin_permissions_level_range" CHECK ("level" >= 0 AND "level" <= 3);

-- Matches and tournaments.
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_best_of_valid" CHECK ("bestOf" IN (1, 3, 5));

ALTER TABLE "match_maps"
  ADD CONSTRAINT "match_maps_scores_nonneg" CHECK ("scoreA" >= 0 AND "scoreB" >= 0);

ALTER TABLE "tournaments"
  ADD CONSTRAINT "tournaments_best_of_valid" CHECK ("bestOf" IN (1, 3, 5) AND ("bestOfFinal" IS NULL OR "bestOfFinal" IN (1, 3, 5))),
  ADD CONSTRAINT "tournaments_team_size_valid" CHECK ("teamSize" >= 1 AND "teamSize" <= 5),
  ADD CONSTRAINT "tournaments_team_limits_valid" CHECK ("minTeams" >= 2 AND "maxTeams" >= "minTeams" AND "maxTeams" <= 256),
  ADD CONSTRAINT "tournaments_elo_range_valid" CHECK ("minElo" IS NULL OR "maxElo" IS NULL OR "minElo" <= "maxElo");

-- Servers.
ALTER TABLE "servers"
  ADD CONSTRAINT "servers_port_range" CHECK ("port" >= 1 AND "port" <= 65535),
  ADD CONSTRAINT "servers_players_nonneg" CHECK ("playerCount" >= 0 AND "maxPlayers" > 0);

-- A user has at most one active loadout.
CREATE UNIQUE INDEX "loadouts_one_active_per_owner" ON "loadouts" ("ownerId") WHERE "isActive";

-- A map can be banned/picked/decided only once per match (SIDE rows reference an already-used map).
CREATE UNIQUE INDEX "match_veto_unique_map" ON "match_veto_actions" ("matchId", "mapId") WHERE "action" <> 'SIDE';

-- No duplicate pending invitations for the same target.
CREATE UNIQUE INDEX "team_invites_one_pending" ON "team_invites" ("teamId", "inviteeId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "party_invites_one_pending" ON "party_invites" ("partyId", "inviteeId") WHERE "status" = 'PENDING';
