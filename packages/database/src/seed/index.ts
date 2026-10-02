import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../client.js';
import { ensureSystemData } from '../system-data.js';

/**
 * Demo data for development and screenshots: 20 players, 4 teams, 2 tournaments, 10 finished matches.
 * Demo players use SteamIDs in the reserved range 76561198999990xxx and the display prefix "Demo".
 * Refuses to run in production unless SEED_DEMO=true, and is idempotent (a second run changes nothing).
 */
const DEMO_STEAM_BASE = 76561198999990000n;
const TEAM_NAMES = [
  ['Iron Wolves', 'IRW'],
  ['Night Owls', 'OWL'],
  ['Pixel Pirates', 'PXP'],
  ['Rush B Cyka', 'RBC'],
] as const;
const NICKS = ['Aurora', 'Blaze', 'Cipher', 'Dagger', 'Echo', 'Falcon', 'Ghost', 'Hydra', 'Ion', 'Jinx', 'Kilo', 'Lynx', 'Mirage', 'Nova', 'Onyx', 'Pulse', 'Quartz', 'Raven', 'Sable', 'Tundra'];
const ELO_STEP = 12; // flat demo delta per match; real matches go through the Elo engine

async function main(): Promise<void> {
  try {
    loadEnvFile(fileURLToPath(new URL('../../../../.env', import.meta.url)));
  } catch {
    /* environment may already be set (Docker) */
  }
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    console.error('Refusing to seed demo data in production (set SEED_DEMO=true to override).');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = createPrismaClient(url);

  try {
    await ensureSystemData(prisma);
    const steamIds = NICKS.map((_, i) => String(DEMO_STEAM_BASE + BigInt(i)));
    if ((await prisma.user.count({ where: { steamId: { in: steamIds } } })) > 0) {
      console.log('Demo data already present – nothing to do.');
      return;
    }

    const modes = ['FIVE_V_FIVE', 'WINGMAN'] as const;
    const users = [];
    for (let i = 0; i < NICKS.length; i++) {
      const user = await prisma.user.create({ data: { steamId: steamIds[i]!, displayName: `Demo ${NICKS[i]}` } });
      await prisma.playerRank.createMany({ data: modes.map((mode) => ({ userId: user.id, mode })) });
      await prisma.playerStats.createMany({ data: modes.map((mode) => ({ userId: user.id, mode })) });
      users.push(user);
    }

    const teams = [];
    for (let i = 0; i < TEAM_NAMES.length; i++) {
      const [name, tag] = TEAM_NAMES[i]!;
      const members = users.slice(i * 5, i * 5 + 5);
      const team = await prisma.team.create({ data: { name, nameKey: name.toLowerCase(), tag, mode: 'FIVE_V_FIVE', captainId: members[0]!.id } });
      await prisma.teamMember.createMany({ data: members.map((m, j) => ({ teamId: team.id, userId: m.id, mode: 'FIVE_V_FIVE' as const, role: j === 0 ? ('CAPTAIN' as const) : ('MEMBER' as const) })) });
      teams.push({ team, members });
    }

    const pool = await prisma.mapPool.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const maps = await prisma.gameMap.findMany({ orderBy: { name: 'asc' }, take: 7 });
    const now = Date.now();
    const day = 86_400_000;

    // Two tournaments: one open for registration, one still a draft.
    await prisma.tournament.create({
      data: { name: 'Demo Open Cup', description: 'Demo tournament with open registration.', status: 'SCHEDULED', format: 'SINGLE_ELIMINATION', mode: 'FIVE_V_FIVE', teamSize: 5, maxTeams: 8, minTeams: 2, bestOf: 1, bestOfFinal: 3, registrationOpen: true, startsAt: new Date(now + 3 * day), mapPoolId: pool.id },
    });
    await prisma.tournament.create({
      data: { name: 'Demo Double Trouble', description: 'Draft double-elimination tournament.', status: 'DRAFT', format: 'DOUBLE_ELIMINATION', mode: 'FIVE_V_FIVE', teamSize: 5, maxTeams: 8, minTeams: 4, bestOf: 3, startsAt: new Date(now + 10 * day), mapPoolId: pool.id },
    });

    // Ten finished custom matches between the four teams, round-robin twice (A–B, C–D, A–C, B–D, A–D, B–C, …).
    const pairs = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2], [1, 0], [3, 2], [2, 0], [3, 1]] as const;
    const elo = new Map<string, { elo: number; wins: number; losses: number; matches: number; streak: number; best: number }>();
    for (const u of users) elo.set(u.id, { elo: 1000, wins: 0, losses: 0, matches: 0, streak: 0, best: 0 });

    for (let n = 0; n < pairs.length; n++) {
      const [ia, ib] = pairs[n]!;
      const a = teams[ia]!;
      const b = teams[ib]!;
      const aWins = (n + ia) % 3 !== 0;
      const scoreA = aWins ? 13 : 8 + (n % 5);
      const scoreB = aWins ? 6 + (n % 6) : 13;
      const finishedAt = new Date(now - (pairs.length - n) * day);
      const map = maps[n % maps.length]!;

      const match = await prisma.match.create({
        data: { kind: 'CUSTOM', mode: 'FIVE_V_FIVE', status: 'FINISHED', bestOf: 1, mapPoolId: pool.id, startedAt: new Date(finishedAt.getTime() - 40 * 60_000), finishedAt, winnerSlot: aWins ? 'A' : 'B', resultType: 'NORMAL', finalizedKey: `demo-seed-${n}` },
      });
      const slots = [['A', a, aWins, scoreA], ['B', b, !aWins, scoreB]] as const;
      for (const [slot, side, won, score] of slots) {
        const mt = await prisma.matchTeam.create({ data: { matchId: match.id, slot, name: side.team.name, teamId: side.team.id, seriesScore: won ? 1 : 0, maxPlayers: 5, averageElo: 1000 } });
        for (const [k, member] of side.members.entries()) {
          const r = elo.get(member.id)!;
          const before = r.elo;
          const delta = won ? ELO_STEP : -ELO_STEP;
          r.elo += delta;
          r.matches++;
          if (won) { r.wins++; r.streak = Math.max(r.streak, 0) + 1; r.best = Math.max(r.best, r.streak); } else { r.losses++; r.streak = Math.min(r.streak, 0) - 1; }
          const rounds = scoreA + scoreB;
          const kills = 12 + ((n * 7 + k * 5) % 14) + (won ? 4 : 0);
          const deaths = 10 + ((n * 3 + k * 4) % 12) + (won ? 0 : 3);
          await prisma.matchPlayer.create({
            data: { matchId: match.id, matchTeamId: mt.id, userId: member.id, steamId: member.steamId, mode: 'FIVE_V_FIVE', isCaptain: k === 0, won, finishedAt, eloBefore: before, eloAfter: r.elo, eloDelta: delta, rounds, kills, deaths, assists: 3 + ((n + k) % 6), headshots: Math.floor(kills * 0.45), damage: kills * 82 + 200, mvps: 2 + (k % 4) },
          });
          await prisma.playerStats.update({ where: { userId_mode: { userId: member.id, mode: 'FIVE_V_FIVE' } }, data: { rounds: { increment: rounds }, kills: { increment: kills }, deaths: { increment: deaths }, assists: { increment: 3 + ((n + k) % 6) }, headshots: { increment: Math.floor(kills * 0.45) }, damage: { increment: kills * 82 + 200 }, mvps: { increment: 2 + (k % 4) } } });
        }
      }
      await prisma.matchMap.create({ data: { matchId: match.id, mapNumber: 1, mapId: map.id, status: 'FINISHED', scoreA, scoreB, rounds: scoreA + scoreB, winnerSlot: aWins ? 'A' : 'B', resultKey: `demo-seed-${n}-1`, startedAt: new Date(finishedAt.getTime() - 40 * 60_000), finishedAt } });
    }

    for (const [userId, r] of elo) {
      await prisma.playerRank.update({ where: { userId_mode: { userId, mode: 'FIVE_V_FIVE' } }, data: { elo: r.elo, peakElo: Math.max(r.elo, 1000), wins: r.wins, losses: r.losses, matches: r.matches, currentStreak: r.streak, bestWinStreak: r.best, lastMatchAt: new Date(now - day) } });
    }
    console.log(`Seeded ${users.length} players, ${teams.length} teams, 2 tournaments, ${pairs.length} matches.`);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
