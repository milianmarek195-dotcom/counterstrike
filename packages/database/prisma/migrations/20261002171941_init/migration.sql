-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('FIVE_V_FIVE', 'WINGMAN');

-- CreateEnum
CREATE TYPE "TeamSlot" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "TournamentFormat" AS ENUM ('SINGLE_ELIMINATION', 'DOUBLE_ELIMINATION', 'ROUND_ROBIN', 'SWISS');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'FINISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TournamentVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "SeedingMethod" AS ENUM ('ELO', 'RANDOM', 'MANUAL');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('REGISTERED', 'ASSIGNED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TournamentTeamStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISQUALIFIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BracketSide" AS ENUM ('UPPER', 'LOWER', 'GRAND_FINAL', 'GROUP');

-- CreateEnum
CREATE TYPE "MatchKind" AS ENUM ('TOURNAMENT', 'MATCHMAKING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'WAITING', 'READY_CHECK', 'VETO', 'CONFIGURING', 'LIVE', 'FINISHED', 'CANCELLED', 'SERVER_ERROR');

-- CreateEnum
CREATE TYPE "MatchResultType" AS ENUM ('NORMAL', 'FORFEIT', 'ADMIN_DECISION');

-- CreateEnum
CREATE TYPE "MatchMapStatus" AS ENUM ('PENDING', 'LIVE', 'FINISHED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "VetoActionType" AS ENUM ('BAN', 'PICK', 'SIDE', 'DECIDER');

-- CreateEnum
CREATE TYPE "StartingSide" AS ENUM ('CT', 'T');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('ONLINE', 'OFFLINE', 'STARTING', 'READY', 'IN_USE', 'ERROR');

-- CreateEnum
CREATE TYPE "AdminActionType" AS ENUM ('MATCH_PREPARE', 'MATCH_START', 'MATCH_PAUSE', 'MATCH_UNPAUSE', 'MATCH_RESUME', 'MATCH_RESTART', 'MATCH_CHANGE_MAP', 'MATCH_FORCE_TEAM', 'MATCH_REMOVE_PLAYER', 'MATCH_PARDON_PLAYER', 'MATCH_SET_SCORE', 'MATCH_CANCEL', 'PLAYER_REFRESH_SKINS', 'SERVER_RELOAD_CONFIG');

-- CreateEnum
CREATE TYPE "AdminActionStatus" AS ENUM ('PENDING', 'DELIVERED', 'ACKED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "BanType" AS ENUM ('PLATFORM', 'MATCH');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('CAPTAIN', 'MEMBER', 'SUBSTITUTE');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PartyStatus" AS ENUM ('OPEN', 'QUEUED', 'IN_MATCH');

-- CreateEnum
CREATE TYPE "EloOutcome" AS ENUM ('WIN', 'LOSS', 'DRAW');

-- CreateEnum
CREATE TYPE "LoadoutVisibility" AS ENUM ('PRIVATE', 'UNLISTED', 'PUBLIC');

-- CreateEnum
CREATE TYPE "LoadoutSlot" AS ENUM ('KNIFE', 'GLOVES', 'PISTOL', 'RIFLE', 'AWP', 'SMG', 'SHOTGUN', 'MACHINE_GUN');

-- CreateEnum
CREATE TYPE "SkinVariant" AS ENUM ('NORMAL', 'STATTRAK', 'SOUVENIR');

-- CreateEnum
CREATE TYPE "SkinWear" AS ENUM ('FACTORY_NEW', 'MINIMAL_WEAR', 'FIELD_TESTED', 'WELL_WORN', 'BATTLE_SCARRED', 'NONE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "steamId" VARCHAR(20) NOT NULL,
    "displayName" VARCHAR(64) NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "steam_profiles" (
    "userId" UUID NOT NULL,
    "personaName" VARCHAR(128) NOT NULL,
    "avatarSmall" TEXT,
    "avatarMedium" TEXT,
    "avatarFull" TEXT,
    "profileUrl" TEXT,
    "countryCode" VARCHAR(2),
    "visibilityState" INTEGER NOT NULL DEFAULT 1,
    "accountCreatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "steam_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(256),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permission" VARCHAR(64) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permission")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "grantedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "player_ranks" (
    "userId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "elo" INTEGER NOT NULL DEFAULT 1000,
    "peakElo" INTEGER NOT NULL DEFAULT 1000,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "bestWinStreak" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "matches" INTEGER NOT NULL DEFAULT 0,
    "lastMatchAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_ranks_pkey" PRIMARY KEY ("userId","mode")
);

-- CreateTable
CREATE TABLE "player_stats" (
    "userId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "deaths" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "headshots" INTEGER NOT NULL DEFAULT 0,
    "damage" INTEGER NOT NULL DEFAULT 0,
    "mvps" INTEGER NOT NULL DEFAULT 0,
    "flashAssists" INTEGER NOT NULL DEFAULT 0,
    "utilityDamage" INTEGER NOT NULL DEFAULT 0,
    "clutches" INTEGER NOT NULL DEFAULT 0,
    "entryKills" INTEGER NOT NULL DEFAULT 0,
    "entryDeaths" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_stats_pkey" PRIMARY KEY ("userId","mode")
);

-- CreateTable
CREATE TABLE "elo_changes" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "outcome" "EloOutcome" NOT NULL,
    "eloBefore" INTEGER NOT NULL,
    "eloAfter" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "kFactor" INTEGER NOT NULL,
    "expectedScore" DOUBLE PRECISION NOT NULL,
    "ownTeamElo" INTEGER NOT NULL,
    "opponentTeamElo" INTEGER NOT NULL,
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elo_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rank_tiers" (
    "id" UUID NOT NULL,
    "key" VARCHAR(32) NOT NULL,
    "name" VARCHAR(32) NOT NULL,
    "minElo" INTEGER NOT NULL,
    "color" VARCHAR(16) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "rank_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "key" VARCHAR(80) NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "maps" (
    "id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "imageUrl" TEXT,
    "workshopId" VARCHAR(32),
    "modes" "GameMode"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_pools" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "mode" "GameMode",
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "map_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "map_pool_maps" (
    "mapPoolId" UUID NOT NULL,
    "mapId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "map_pool_maps_pkey" PRIMARY KEY ("mapPoolId","mapId")
);

-- CreateTable
CREATE TABLE "veto_templates" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "bestOf" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "veto_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "nameKey" VARCHAR(40) NOT NULL,
    "tag" VARCHAR(6),
    "mode" "GameMode" NOT NULL,
    "logoUrl" TEXT,
    "captainId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disbandedAt" TIMESTAMP(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invites" (
    "id" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "invitedById" UUID NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "team_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL,
    "leaderId" UUID NOT NULL,
    "mode" "GameMode" NOT NULL DEFAULT 'FIVE_V_FIVE',
    "status" "PartyStatus" NOT NULL DEFAULT 'OPEN',
    "queuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_members" (
    "id" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_invites" (
    "id" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "inviteeId" UUID NOT NULL,
    "invitedById" UUID NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "port" INTEGER NOT NULL,
    "region" VARCHAR(16) NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'OFFLINE',
    "maxPlayers" INTEGER NOT NULL DEFAULT 12,
    "playerCount" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maintenanceHold" BOOLEAN NOT NULL DEFAULT false,
    "skinsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "pluginVersion" VARCHAR(32),
    "gameVersion" VARCHAR(32),
    "health" JSONB,
    "lastHeartbeatAt" TIMESTAMP(3),
    "currentMatchId" UUID,
    "reservedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_events" (
    "id" UUID NOT NULL,
    "serverId" UUID NOT NULL,
    "matchId" UUID,
    "type" VARCHAR(64) NOT NULL,
    "seq" INTEGER,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "serverTimestamp" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_actions" (
    "id" UUID NOT NULL,
    "serverId" UUID NOT NULL,
    "matchId" UUID,
    "type" "AdminActionType" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "AdminActionStatus" NOT NULL DEFAULT 'PENDING',
    "issuedById" UUID,
    "idempotencyKey" VARCHAR(128),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournaments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "rules" TEXT,
    "status" "TournamentStatus" NOT NULL DEFAULT 'DRAFT',
    "format" "TournamentFormat" NOT NULL,
    "mode" "GameMode" NOT NULL,
    "teamSize" INTEGER NOT NULL,
    "maxTeams" INTEGER NOT NULL,
    "minTeams" INTEGER NOT NULL DEFAULT 2,
    "bestOf" INTEGER NOT NULL DEFAULT 1,
    "bestOfFinal" INTEGER,
    "grandFinalReset" BOOLEAN NOT NULL DEFAULT true,
    "seedingMethod" "SeedingMethod" NOT NULL DEFAULT 'ELO',
    "visibility" "TournamentVisibility" NOT NULL DEFAULT 'PUBLIC',
    "registrationOpen" BOOLEAN NOT NULL DEFAULT false,
    "allowSubstitutes" BOOLEAN NOT NULL DEFAULT true,
    "substitutesPerTeam" INTEGER NOT NULL DEFAULT 1,
    "minElo" INTEGER,
    "maxElo" INTEGER,
    "passwordHash" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "mapPoolId" UUID NOT NULL,
    "vetoTemplateId" UUID,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_servers" (
    "tournamentId" UUID NOT NULL,
    "serverId" UUID NOT NULL,

    CONSTRAINT "tournament_servers_pkey" PRIMARY KEY ("tournamentId","serverId")
);

-- CreateTable
CREATE TABLE "tournament_registrations" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'REGISTERED',
    "eloAtRegistration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_teams" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "teamId" UUID,
    "name" VARCHAR(40) NOT NULL,
    "nameKey" VARCHAR(40) NOT NULL,
    "logoUrl" TEXT,
    "seed" INTEGER,
    "averageElo" INTEGER NOT NULL DEFAULT 1000,
    "status" "TournamentTeamStatus" NOT NULL DEFAULT 'PENDING',
    "placement" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_team_members" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "tournamentTeamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',

    CONSTRAINT "tournament_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_matches" (
    "id" UUID NOT NULL,
    "tournamentId" UUID NOT NULL,
    "matchId" UUID,
    "side" "BracketSide" NOT NULL,
    "round" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "label" VARCHAR(48),
    "teamAId" UUID,
    "teamBId" UUID,
    "winnerId" UUID,
    "isBye" BOOLEAN NOT NULL DEFAULT false,
    "winnerNextId" UUID,
    "winnerNextSlot" "TeamSlot",
    "loserNextId" UUID,
    "loserNextSlot" "TeamSlot",

    CONSTRAINT "tournament_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" UUID NOT NULL,
    "kind" "MatchKind" NOT NULL DEFAULT 'TOURNAMENT',
    "mode" "GameMode" NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "bestOf" INTEGER NOT NULL DEFAULT 1,
    "mapPoolId" UUID,
    "vetoTemplateId" UUID,
    "vetoStartsWith" "TeamSlot",
    "vetoDeadline" TIMESTAMP(3),
    "serverId" UUID,
    "scheduledAt" TIMESTAMP(3),
    "readyCheckStartedAt" TIMESTAMP(3),
    "readyDeadline" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "pausedByTeam" "TeamSlot",
    "winnerSlot" "TeamSlot",
    "resultType" "MatchResultType",
    "finalizedKey" VARCHAR(128),
    "cancelReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_teams" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "slot" "TeamSlot" NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "teamId" UUID,
    "tournamentTeamId" UUID,
    "averageElo" INTEGER NOT NULL DEFAULT 1000,
    "seriesScore" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "match_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_players" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "matchTeamId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "steamId" VARCHAR(20) NOT NULL,
    "mode" "GameMode" NOT NULL,
    "isSubstitute" BOOLEAN NOT NULL DEFAULT false,
    "readyAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "removalReason" TEXT,
    "won" BOOLEAN,
    "finishedAt" TIMESTAMP(3),
    "eloBefore" INTEGER,
    "eloAfter" INTEGER,
    "eloDelta" INTEGER,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "deaths" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "headshots" INTEGER NOT NULL DEFAULT 0,
    "damage" INTEGER NOT NULL DEFAULT 0,
    "mvps" INTEGER NOT NULL DEFAULT 0,
    "flashAssists" INTEGER NOT NULL DEFAULT 0,
    "utilityDamage" INTEGER NOT NULL DEFAULT 0,
    "clutches" INTEGER NOT NULL DEFAULT 0,
    "entryKills" INTEGER NOT NULL DEFAULT 0,
    "entryDeaths" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "match_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_maps" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "mapNumber" INTEGER NOT NULL,
    "mapId" UUID NOT NULL,
    "pickedBy" "TeamSlot",
    "teamAStartSide" "StartingSide",
    "status" "MatchMapStatus" NOT NULL DEFAULT 'PENDING',
    "scoreA" INTEGER NOT NULL DEFAULT 0,
    "scoreB" INTEGER NOT NULL DEFAULT 0,
    "rounds" INTEGER,
    "winnerSlot" "TeamSlot",
    "resultKey" VARCHAR(128),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "match_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_player_map_stats" (
    "id" UUID NOT NULL,
    "matchMapId" UUID NOT NULL,
    "matchPlayerId" UUID NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 0,
    "kills" INTEGER NOT NULL DEFAULT 0,
    "deaths" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "headshots" INTEGER NOT NULL DEFAULT 0,
    "damage" INTEGER NOT NULL DEFAULT 0,
    "mvps" INTEGER NOT NULL DEFAULT 0,
    "flashAssists" INTEGER NOT NULL DEFAULT 0,
    "utilityDamage" INTEGER NOT NULL DEFAULT 0,
    "clutches" INTEGER NOT NULL DEFAULT 0,
    "entryKills" INTEGER NOT NULL DEFAULT 0,
    "entryDeaths" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "match_player_map_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_veto_actions" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "team" "TeamSlot",
    "action" "VetoActionType" NOT NULL,
    "mapId" UUID NOT NULL,
    "side" "StartingSide",
    "actedByUserId" UUID,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_veto_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bans" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "BanType" NOT NULL,
    "matchId" UUID,
    "reason" TEXT NOT NULL,
    "issuedById" UUID,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "actorLabel" VARCHAR(128) NOT NULL,
    "action" VARCHAR(80) NOT NULL,
    "targetType" VARCHAR(40) NOT NULL,
    "targetId" VARCHAR(64),
    "targetLabel" VARCHAR(128),
    "reason" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "metadata" JSONB,
    "ip" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "urlEncrypted" TEXT NOT NULL,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skins" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(64),
    "weaponDefIndex" INTEGER NOT NULL,
    "weaponClass" VARCHAR(64) NOT NULL,
    "weaponName" VARCHAR(64) NOT NULL,
    "slot" "LoadoutSlot" NOT NULL,
    "paintIndex" INTEGER NOT NULL,
    "name" VARCHAR(96) NOT NULL,
    "rarity" VARCHAR(48),
    "collection" VARCHAR(96),
    "minFloat" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxFloat" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "statTrakAvailable" BOOLEAN NOT NULL DEFAULT false,
    "souvenirAvailable" BOOLEAN NOT NULL DEFAULT false,
    "imageUrl" TEXT,
    "priceMaxUsd" DOUBLE PRECISION,
    "priceUpdatedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skin_prices" (
    "id" UUID NOT NULL,
    "skinId" UUID NOT NULL,
    "wear" "SkinWear" NOT NULL,
    "variant" "SkinVariant" NOT NULL DEFAULT 'NORMAL',
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skin_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stickers" (
    "id" UUID NOT NULL,
    "externalId" VARCHAR(64),
    "defIndex" INTEGER NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "rarity" VARCHAR(48),
    "tournament" VARCHAR(96),
    "imageUrl" TEXT,
    "priceUsd" DOUBLE PRECISION,
    "priceUpdatedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "stickers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loadouts" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "shareCode" VARCHAR(24) NOT NULL,
    "visibility" "LoadoutVisibility" NOT NULL DEFAULT 'PRIVATE',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "importedFromId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loadouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loadout_items" (
    "id" UUID NOT NULL,
    "loadoutId" UUID NOT NULL,
    "slot" "LoadoutSlot" NOT NULL,
    "weaponDefIndex" INTEGER NOT NULL,
    "skinId" UUID,
    "paintSeed" INTEGER NOT NULL DEFAULT 0,
    "floatValue" DOUBLE PRECISION NOT NULL DEFAULT 0.001,
    "statTrak" BOOLEAN NOT NULL DEFAULT false,
    "statTrakCount" INTEGER NOT NULL DEFAULT 0,
    "souvenir" BOOLEAN NOT NULL DEFAULT false,
    "nameTag" VARCHAR(20),

    CONSTRAINT "loadout_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loadout_item_stickers" (
    "id" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "stickerId" UUID NOT NULL,
    "slotIndex" INTEGER NOT NULL,
    "wear" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "offsetX" DOUBLE PRECISION,
    "offsetY" DOUBLE PRECISION,
    "rotation" DOUBLE PRECISION,
    "scale" DOUBLE PRECISION,

    CONSTRAINT "loadout_item_stickers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skin_permissions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "stickerCrafts" BOOLEAN NOT NULL DEFAULT false,
    "floatEditing" BOOLEAN NOT NULL DEFAULT false,
    "customLoadouts" BOOLEAN NOT NULL DEFAULT true,
    "grantedById" UUID,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skin_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_steamId_key" ON "users"("steamId");

-- CreateIndex
CREATE INDEX "users_displayName_idx" ON "users"("displayName");

-- CreateIndex
CREATE INDEX "steam_profiles_lastSyncedAt_idx" ON "steam_profiles"("lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_absoluteExpiresAt_idx" ON "sessions"("absoluteExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "player_ranks_mode_elo_idx" ON "player_ranks"("mode", "elo" DESC);

-- CreateIndex
CREATE INDEX "player_ranks_mode_wins_idx" ON "player_ranks"("mode", "wins" DESC);

-- CreateIndex
CREATE INDEX "player_stats_mode_kills_idx" ON "player_stats"("mode", "kills" DESC);

-- CreateIndex
CREATE INDEX "elo_changes_userId_createdAt_idx" ON "elo_changes"("userId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "elo_changes_matchId_userId_key" ON "elo_changes"("matchId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "rank_tiers_key_key" ON "rank_tiers"("key");

-- CreateIndex
CREATE UNIQUE INDEX "rank_tiers_minElo_key" ON "rank_tiers"("minElo");

-- CreateIndex
CREATE UNIQUE INDEX "maps_key_key" ON "maps"("key");

-- CreateIndex
CREATE UNIQUE INDEX "map_pools_name_key" ON "map_pools"("name");

-- CreateIndex
CREATE INDEX "map_pool_maps_mapId_idx" ON "map_pool_maps"("mapId");

-- CreateIndex
CREATE INDEX "veto_templates_bestOf_isDefault_idx" ON "veto_templates"("bestOf", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "teams_nameKey_key" ON "teams"("nameKey");

-- CreateIndex
CREATE INDEX "teams_mode_disbandedAt_idx" ON "teams"("mode", "disbandedAt");

-- CreateIndex
CREATE INDEX "teams_captainId_idx" ON "teams"("captainId");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_teamId_userId_key" ON "team_members"("teamId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_userId_mode_key" ON "team_members"("userId", "mode");

-- CreateIndex
CREATE INDEX "team_invites_inviteeId_status_idx" ON "team_invites"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "team_invites_teamId_status_idx" ON "team_invites"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "parties_leaderId_key" ON "parties"("leaderId");

-- CreateIndex
CREATE INDEX "parties_status_mode_idx" ON "parties"("status", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "party_members_userId_key" ON "party_members"("userId");

-- CreateIndex
CREATE INDEX "party_members_partyId_idx" ON "party_members"("partyId");

-- CreateIndex
CREATE INDEX "party_invites_inviteeId_status_idx" ON "party_invites"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "party_invites_partyId_status_idx" ON "party_invites"("partyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "servers_currentMatchId_key" ON "servers"("currentMatchId");

-- CreateIndex
CREATE INDEX "servers_status_lastHeartbeatAt_idx" ON "servers"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "servers_ip_port_key" ON "servers"("ip", "port");

-- CreateIndex
CREATE UNIQUE INDEX "server_events_idempotencyKey_key" ON "server_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "server_events_matchId_receivedAt_idx" ON "server_events"("matchId", "receivedAt");

-- CreateIndex
CREATE INDEX "server_events_serverId_receivedAt_idx" ON "server_events"("serverId", "receivedAt");

-- CreateIndex
CREATE INDEX "server_events_receivedAt_idx" ON "server_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_actions_idempotencyKey_key" ON "admin_actions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "admin_actions_serverId_status_createdAt_idx" ON "admin_actions"("serverId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "admin_actions_matchId_idx" ON "admin_actions"("matchId");

-- CreateIndex
CREATE INDEX "tournaments_status_startsAt_idx" ON "tournaments"("status", "startsAt");

-- CreateIndex
CREATE INDEX "tournaments_visibility_status_idx" ON "tournaments"("visibility", "status");

-- CreateIndex
CREATE INDEX "tournament_registrations_userId_idx" ON "tournament_registrations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_registrations_tournamentId_userId_key" ON "tournament_registrations"("tournamentId", "userId");

-- CreateIndex
CREATE INDEX "tournament_teams_teamId_idx" ON "tournament_teams"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_teams_tournamentId_nameKey_key" ON "tournament_teams"("tournamentId", "nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_teams_tournamentId_seed_key" ON "tournament_teams"("tournamentId", "seed");

-- CreateIndex
CREATE INDEX "tournament_team_members_tournamentTeamId_idx" ON "tournament_team_members"("tournamentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_team_members_tournamentId_userId_key" ON "tournament_team_members"("tournamentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_matches_matchId_key" ON "tournament_matches"("matchId");

-- CreateIndex
CREATE INDEX "tournament_matches_tournamentId_round_idx" ON "tournament_matches"("tournamentId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_matches_tournamentId_side_round_position_key" ON "tournament_matches"("tournamentId", "side", "round", "position");

-- CreateIndex
CREATE UNIQUE INDEX "matches_finalizedKey_key" ON "matches"("finalizedKey");

-- CreateIndex
CREATE INDEX "matches_status_scheduledAt_idx" ON "matches"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "matches_finishedAt_idx" ON "matches"("finishedAt" DESC);

-- CreateIndex
CREATE INDEX "matches_serverId_idx" ON "matches"("serverId");

-- CreateIndex
CREATE INDEX "matches_kind_status_idx" ON "matches"("kind", "status");

-- CreateIndex
CREATE INDEX "match_teams_teamId_idx" ON "match_teams"("teamId");

-- CreateIndex
CREATE INDEX "match_teams_tournamentTeamId_idx" ON "match_teams"("tournamentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "match_teams_matchId_slot_key" ON "match_teams"("matchId", "slot");

-- CreateIndex
CREATE INDEX "match_players_userId_finishedAt_idx" ON "match_players"("userId", "finishedAt" DESC);

-- CreateIndex
CREATE INDEX "match_players_steamId_idx" ON "match_players"("steamId");

-- CreateIndex
CREATE INDEX "match_players_matchTeamId_idx" ON "match_players"("matchTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "match_players_matchId_userId_key" ON "match_players"("matchId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "match_maps_resultKey_key" ON "match_maps"("resultKey");

-- CreateIndex
CREATE INDEX "match_maps_mapId_idx" ON "match_maps"("mapId");

-- CreateIndex
CREATE UNIQUE INDEX "match_maps_matchId_mapNumber_key" ON "match_maps"("matchId", "mapNumber");

-- CreateIndex
CREATE INDEX "match_player_map_stats_matchPlayerId_idx" ON "match_player_map_stats"("matchPlayerId");

-- CreateIndex
CREATE UNIQUE INDEX "match_player_map_stats_matchMapId_matchPlayerId_key" ON "match_player_map_stats"("matchMapId", "matchPlayerId");

-- CreateIndex
CREATE INDEX "match_veto_actions_mapId_idx" ON "match_veto_actions"("mapId");

-- CreateIndex
CREATE UNIQUE INDEX "match_veto_actions_matchId_stepIndex_key" ON "match_veto_actions"("matchId", "stepIndex");

-- CreateIndex
CREATE INDEX "bans_userId_type_revokedAt_idx" ON "bans"("userId", "type", "revokedAt");

-- CreateIndex
CREATE INDEX "bans_createdAt_idx" ON "bans"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "bans_matchId_idx" ON "bans"("matchId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_createdAt_idx" ON "audit_logs"("targetType", "targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "skins_externalId_key" ON "skins"("externalId");

-- CreateIndex
CREATE INDEX "skins_slot_active_idx" ON "skins"("slot", "active");

-- CreateIndex
CREATE INDEX "skins_name_idx" ON "skins"("name");

-- CreateIndex
CREATE INDEX "skins_priceMaxUsd_idx" ON "skins"("priceMaxUsd");

-- CreateIndex
CREATE UNIQUE INDEX "skins_weaponDefIndex_paintIndex_key" ON "skins"("weaponDefIndex", "paintIndex");

-- CreateIndex
CREATE INDEX "skin_prices_fetchedAt_idx" ON "skin_prices"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "skin_prices_skinId_wear_variant_key" ON "skin_prices"("skinId", "wear", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "stickers_externalId_key" ON "stickers"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "stickers_defIndex_key" ON "stickers"("defIndex");

-- CreateIndex
CREATE INDEX "stickers_name_idx" ON "stickers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "loadouts_shareCode_key" ON "loadouts"("shareCode");

-- CreateIndex
CREATE INDEX "loadouts_ownerId_idx" ON "loadouts"("ownerId");

-- CreateIndex
CREATE INDEX "loadouts_visibility_createdAt_idx" ON "loadouts"("visibility", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "loadout_items_skinId_idx" ON "loadout_items"("skinId");

-- CreateIndex
CREATE UNIQUE INDEX "loadout_items_loadoutId_weaponDefIndex_key" ON "loadout_items"("loadoutId", "weaponDefIndex");

-- CreateIndex
CREATE INDEX "loadout_item_stickers_stickerId_idx" ON "loadout_item_stickers"("stickerId");

-- CreateIndex
CREATE UNIQUE INDEX "loadout_item_stickers_itemId_slotIndex_key" ON "loadout_item_stickers"("itemId", "slotIndex");

-- CreateIndex
CREATE INDEX "skin_permissions_userId_createdAt_idx" ON "skin_permissions"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "skin_permissions_expiresAt_idx" ON "skin_permissions"("expiresAt");

-- AddForeignKey
ALTER TABLE "steam_profiles" ADD CONSTRAINT "steam_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_ranks" ADD CONSTRAINT "player_ranks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elo_changes" ADD CONSTRAINT "elo_changes_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elo_changes" ADD CONSTRAINT "elo_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_pool_maps" ADD CONSTRAINT "map_pool_maps_mapPoolId_fkey" FOREIGN KEY ("mapPoolId") REFERENCES "map_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "map_pool_maps" ADD CONSTRAINT "map_pool_maps_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "maps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_invites" ADD CONSTRAINT "party_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_currentMatchId_fkey" FOREIGN KEY ("currentMatchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_events" ADD CONSTRAINT "server_events_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_events" ADD CONSTRAINT "server_events_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_mapPoolId_fkey" FOREIGN KEY ("mapPoolId") REFERENCES "map_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_vetoTemplateId_fkey" FOREIGN KEY ("vetoTemplateId") REFERENCES "veto_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_servers" ADD CONSTRAINT "tournament_servers_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_servers" ADD CONSTRAINT "tournament_servers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_registrations" ADD CONSTRAINT "tournament_registrations_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_registrations" ADD CONSTRAINT "tournament_registrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_teams" ADD CONSTRAINT "tournament_teams_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_teams" ADD CONSTRAINT "tournament_teams_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_team_members" ADD CONSTRAINT "tournament_team_members_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_team_members" ADD CONSTRAINT "tournament_team_members_tournamentTeamId_fkey" FOREIGN KEY ("tournamentTeamId") REFERENCES "tournament_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_team_members" ADD CONSTRAINT "tournament_team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_teamAId_fkey" FOREIGN KEY ("teamAId") REFERENCES "tournament_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_teamBId_fkey" FOREIGN KEY ("teamBId") REFERENCES "tournament_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "tournament_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_winnerNextId_fkey" FOREIGN KEY ("winnerNextId") REFERENCES "tournament_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_loserNextId_fkey" FOREIGN KEY ("loserNextId") REFERENCES "tournament_matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_mapPoolId_fkey" FOREIGN KEY ("mapPoolId") REFERENCES "map_pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_vetoTemplateId_fkey" FOREIGN KEY ("vetoTemplateId") REFERENCES "veto_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_teams" ADD CONSTRAINT "match_teams_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_teams" ADD CONSTRAINT "match_teams_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_teams" ADD CONSTRAINT "match_teams_tournamentTeamId_fkey" FOREIGN KEY ("tournamentTeamId") REFERENCES "tournament_teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_matchTeamId_fkey" FOREIGN KEY ("matchTeamId") REFERENCES "match_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_maps" ADD CONSTRAINT "match_maps_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_maps" ADD CONSTRAINT "match_maps_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "maps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_player_map_stats" ADD CONSTRAINT "match_player_map_stats_matchMapId_fkey" FOREIGN KEY ("matchMapId") REFERENCES "match_maps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_player_map_stats" ADD CONSTRAINT "match_player_map_stats_matchPlayerId_fkey" FOREIGN KEY ("matchPlayerId") REFERENCES "match_players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_veto_actions" ADD CONSTRAINT "match_veto_actions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_veto_actions" ADD CONSTRAINT "match_veto_actions_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "maps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_veto_actions" ADD CONSTRAINT "match_veto_actions_actedByUserId_fkey" FOREIGN KEY ("actedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bans" ADD CONSTRAINT "bans_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skin_prices" ADD CONSTRAINT "skin_prices_skinId_fkey" FOREIGN KEY ("skinId") REFERENCES "skins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadouts" ADD CONSTRAINT "loadouts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout_items" ADD CONSTRAINT "loadout_items_loadoutId_fkey" FOREIGN KEY ("loadoutId") REFERENCES "loadouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout_items" ADD CONSTRAINT "loadout_items_skinId_fkey" FOREIGN KEY ("skinId") REFERENCES "skins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout_item_stickers" ADD CONSTRAINT "loadout_item_stickers_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "loadout_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loadout_item_stickers" ADD CONSTRAINT "loadout_item_stickers_stickerId_fkey" FOREIGN KEY ("stickerId") REFERENCES "stickers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skin_permissions" ADD CONSTRAINT "skin_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skin_permissions" ADD CONSTRAINT "skin_permissions_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
