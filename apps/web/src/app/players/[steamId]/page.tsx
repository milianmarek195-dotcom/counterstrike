'use client';
import Link from 'next/link';
import { use } from 'react';
import { Card, Empty, ErrorBox, Loading, PageTitle, RankBadge, Stat, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, fmtNum } from '@/lib/format';

interface Stats { matches: number; wins: number; losses: number; kd: number; adr: number; hsPercent: number; winRate: number; kills: number; killsAwp: number; killsAk47: number; killsPistol: number }
interface Profile { steamId: string; displayName: string; memberSince: string; modes: { FIVE_V_FIVE: { elo: number; peakElo: number; position: number | null; rank: { name: string; color: string }; streak: number; overall: Stats; last30Days: Stats } } }
interface PMatch { matchId: string; date: string; map: string; opponent: string; result: string; kills: number; deaths: number; assists: number; eloDelta: number | null }

export default function PlayerPage({ params }: { params: Promise<{ steamId: string }> }) {
  const { steamId } = use(params);
  const p = useApi<Profile>(`/players/${steamId}`);
  const h = useApi<{ matches: PMatch[] }>(`/players/${steamId}/matches?pageSize=15`);
  if (p.loading) return <Loading />;
  if (p.error) return <ErrorBox message={p.error.status === 404 ? 'Spieler nicht gefunden.' : p.error.message} />;
  const d = p.data!;
  const m = d.modes.FIVE_V_FIVE;
  return (
    <>
      <PageTitle title={d.displayName} subtitle={`Mitglied seit ${fmtDate(d.memberSince)}`} actions={<RankBadge rank={m.rank} />} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Elo" value={fmtNum(m.elo)} /><Stat label="Peak" value={fmtNum(m.peakElo)} /><Stat label="Position" value={m.position ? `#${m.position}` : '–'} /><Stat label="Serie" value={m.streak > 0 ? `${m.streak} Siege` : m.streak < 0 ? `${-m.streak} Niederl.` : '–'} />
        <Stat label="Kills AWP" value={m.overall.killsAwp} /><Stat label="Kills AK-47" value={m.overall.killsAk47} /><Stat label="Kills Pistole" value={m.overall.killsPistol} /><Stat label="Kills gesamt" value={m.overall.kills} /><Stat label="Matches" value={m.overall.matches} /><Stat label="Win %" value={fmtNum(m.overall.winRate)} /><Stat label="K/D" value={fmtNum(m.overall.kd, 2)} /><Stat label="ADR" value={fmtNum(m.overall.adr, 1)} />
      </div>
      <Card className="mb-6 text-sm text-muted">Letzte 30 Tage: {m.last30Days.matches} Matches · {fmtNum(m.last30Days.winRate)} % Siege · K/D {fmtNum(m.last30Days.kd, 2)} · HS {fmtNum(m.last30Days.hsPercent, 1)} %</Card>
      <h2 className="mb-3 text-lg font-bold">Match-Historie</h2>
      {!h.data?.matches.length ? <Empty>Noch keine Matches.</Empty> : (
        <Table head={['Datum', 'Map', 'Gegner', 'Ergebnis', 'K/D/A', 'Elo']}>
          {h.data.matches.map((x) => (
            <tr key={x.matchId} className="hover:bg-card-hover"><td className="px-3 py-2"><Link className="hover:text-primary" href={`/matches/${x.matchId}`}>{fmtDate(x.date)}</Link></td><td className="px-3 py-2">{x.map}</td><td className="px-3 py-2">{x.opponent}</td><td className={`px-3 py-2 font-semibold ${x.result === 'WIN' ? 'text-success' : 'text-danger'}`}>{x.result}</td><td className="px-3 py-2">{x.kills}/{x.deaths}/{x.assists}</td><td className="px-3 py-2">{x.eloDelta ?? '–'}</td></tr>
          ))}
        </Table>
      )}
    </>
  );
}
