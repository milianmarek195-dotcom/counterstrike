import { Injectable } from '@nestjs/common';
import { roundsToWin, type GameMode, type StartingSide, type TeamSlot } from '@celtist/shared';
import { notFound } from '../common/errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface ServerConfigPlayer {
  steamId: string;
  name: string;
  isCaptain: boolean;
  isSubstitute: boolean;
}

export interface ServerMatchConfig {
  matchId: string;
  mode: GameMode;
  bestOf: number;
  kind: string;
  tournament: { id: string; name: string } | null;
  /** Each side has its own size limit; the engine is generic (1v1, 2v3, 5v5 …). */
  teams: Record<TeamSlot, { name: string; maxPlayers: number; players: ServerConfigPlayer[] } | null>;
  /** Empty until the veto is complete. */
  maps: Array<{ mapNumber: number; key: string; workshopId: string | null; teamAStartSide: StartingSide | null }>;
  rules: {
    roundsToWin: number;
    pausesPerTeam: number;
    pauseMaxSeconds: number;
    teamKillLimit: number;
    teamDamageLimit: number;
  };
  /** Players (by SteamID64) who may use admin chat commands on this server: holders of match.pause. */
  adminSteamIds: string[];
  skinsEnabled: boolean;
}

/** The match description the game server works from: roster, teams, maps/sides and rules. */
@Injectable()
export class MatchConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async build(matchId: string): Promise<ServerMatchConfig> {
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      include: {
        server: { select: { skinsEnabled: true } },
        tournamentMatch: { include: { tournament: { select: { id: true, name: true } } } },
        teams: { include: { players: { where: { removedAt: null }, include: { user: { select: { displayName: true } } } } } },
        maps: { include: { map: true }, orderBy: { mapNumber: 'asc' } },
      },
    });
    if (!match) throw notFound('MATCH_NOT_FOUND', 'Match does not exist');

    const [pausesPerTeam, pauseMaxSeconds, teamKillLimit, teamDamageLimit, admins] = await Promise.all([
      this.settings.get('match.pausesPerTeam'),
      this.settings.get('match.pauseMaxSeconds'),
      this.settings.get('match.teamKillLimit'),
      this.settings.get('match.teamDamageLimit'),
      this.prisma.user.findMany({
        where: { roles: { some: { role: { permissions: { some: { permission: { in: ['*', 'match.pause'] } } } } } } },
        select: { steamId: true },
      }),
    ]);

    const team = (slot: TeamSlot) => {
      const row = match.teams.find((t) => t.slot === slot);
      return row
        ? {
            name: row.name,
            maxPlayers: row.maxPlayers,
            players: row.players.map((p) => ({
              steamId: p.steamId,
              name: p.user.displayName,
              isCaptain: p.isCaptain,
              isSubstitute: p.isSubstitute,
            })),
          }
        : null;
    };

    return {
      matchId: match.id,
      mode: match.mode,
      bestOf: match.bestOf,
      kind: match.kind,
      tournament: match.tournamentMatch ? match.tournamentMatch.tournament : null,
      teams: { A: team('A'), B: team('B') },
      maps: match.maps.map((m) => ({
        mapNumber: m.mapNumber,
        key: m.map.key,
        workshopId: m.map.workshopId,
        teamAStartSide: m.teamAStartSide,
      })),
      rules: {
        roundsToWin: roundsToWin(match.mode),
        pausesPerTeam,
        pauseMaxSeconds,
        teamKillLimit,
        teamDamageLimit,
      },
      adminSteamIds: admins.map((a) => a.steamId),
      skinsEnabled: match.server?.skinsEnabled ?? false,
    };
  }
}
