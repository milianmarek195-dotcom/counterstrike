# Datenbank

PostgreSQL 17, Prisma 7 (`packages/database/prisma/schema.prisma`). Migrationen in `prisma/migrations`, angewendet mit `prisma migrate deploy`.

Kernmodelle: `User`, `Session`, `Role`/`RolePermission`/`UserRole`, `PlayerRank`, `PlayerStats`, `EloChange` (Unique `(matchId,userId)` = Elo nie doppelt), `Team`/`TeamMember`/`TeamInvite`, `Party*`, `Tournament`/`TournamentTeam`/`TournamentMatch`, `Match`/`MatchTeam`/`MatchPlayer`/`MatchMap`/`MatchVetoAction`, `Server`/`ServerEvent`/`AdminAction`, `Ban`, `AuditLog`, `WebhookEndpoint`, `Skin`/`SkinPrice`/`Sticker`, `InventoryItem`(+Sticker), `Loadout`/`LoadoutItem`, `SkinPermission`, `PlatformSetting`, `RankTier`.

Integrität per Datenbank: Partial-Unique-Indizes (ein Server – ein Match), CHECKs für Pattern 0–1000, Float 0–1, Teamgröße 1–16, Sticker-Slots, Wear.

Entwicklung: `scripts/dev-postgres.mjs` startet ein eingebettetes PostgreSQL (Port 54329). Neue Migration: `node scripts/gen-migration.mjs <name>`. Demo-Daten: `npm run db:seed` (nur Entwicklung).
