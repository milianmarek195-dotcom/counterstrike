'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Empty, ErrorBox, Loading, PageTitle, RankBadge, Select, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtNum } from '@/lib/format';

interface Row { position: number; steamId: string; displayName: string; elo: number; rank: { name: string; color: string }; matches: number; winRate: number; kd: number; adr: number; hsPercent: number }

export default function Ranking() {
  const [scope, setScope] = useState('global');
  const [sort, setSort] = useState('elo');
  const { data, loading, error } = useApi<{ entries: Row[] }>(`/ranking?scope=${scope}&sort=${sort}&pageSize=100`);
  return (
    <>
      <PageTitle title="Rangliste" subtitle="Elo wird nur durch gewertete Turnier- und Matchmaking-Matches verändert." actions={
        <div className="flex gap-2">
          <Select aria-label="Zeitraum" value={scope} onChange={(e) => setScope(e.target.value)}><option value="global">Gesamt</option><option value="30d">Letzte 30 Tage</option></Select>
          <Select aria-label="Sortierung" value={sort} onChange={(e) => setSort(e.target.value)}><option value="elo">Elo</option><option value="wins">Siege</option><option value="kd">K/D</option><option value="adr">ADR</option></Select>
        </div>} />
      {error && <ErrorBox message={error.message} />}
      {loading ? <Loading /> : !data?.entries.length ? <Empty>Noch keine Ranglisteneinträge.</Empty> : (
        <Table head={['#', 'Spieler', 'Rang', 'Elo', 'Matches', 'Win %', 'K/D', 'ADR', 'HS %']}>
          {data.entries.map((e) => (
            <tr key={e.steamId} className="hover:bg-card-hover">
              <td className="px-3 py-2">{e.position}</td>
              <td className="px-3 py-2 font-medium"><Link className="hover:text-primary" href={`/players/${e.steamId}`}>{e.displayName}</Link></td>
              <td className="px-3 py-2"><RankBadge rank={e.rank} /></td>
              <td className="px-3 py-2 font-semibold">{fmtNum(e.elo)}</td>
              <td className="px-3 py-2">{e.matches}</td><td className="px-3 py-2">{fmtNum(e.winRate)}</td><td className="px-3 py-2">{fmtNum(e.kd, 2)}</td><td className="px-3 py-2">{fmtNum(e.adr, 1)}</td><td className="px-3 py-2">{fmtNum(e.hsPercent, 1)}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
