'use client';
import Link from 'next/link';
import { use } from 'react';
import { Card, Empty, ErrorBox, Loading, PageTitle, RankBadge, Stat, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, fmtNum } from '@/lib/format';

interface Stats { matches: number; wins: number; losses: number; kd: number; adr: number; hsPercent: number; winRate: number; kills: number; killsAwp: number; killsAk47: number; killsPistol: number }
interface Profile { steamId: string; displayName: string; memberSince: string; modes: { FIVE_V_FIVE: { elo: number; peakElo: number; position: number | null; rank: { name: string; color: string }; streak: number; overall: Stats; last30Days: Stats } } }
interface PMatch { matchId: string; date: string; map: string; opponent: string; result: string; kills: number; deaths: number; assists: number; eloDelta: number | null }

interface LoItem { weaponDefIndex: number; team: 'BOTH' | 'T' | 'CT'; item: { slot: string; skin: { name: string; phase: string | null; weaponName: string; imageUrl: string | null; rarity: string | null } | null; float: number; pattern: number; statTrak: boolean } }
const RARITY: Record<string, string> = { 'Consumer Grade': '#b0c3d9', 'Industrial Grade': '#5e98d9', 'Mil-Spec Grade': '#4b69ff', Restricted: '#8847ff', Classified: '#d32ce6', Covert: '#eb4b4b', Contraband: '#e4ae39', Extraordinary: '#eb4b4b', Superior: '#d32ce6' };
const SIDE_LABEL = { BOTH: 'T + CT', T: 'T', CT: 'CT' } as const;

/** Read-only view of the equipped skins, agents, knife and gloves of a player. */
function PublicLoadout({ steamId }: { steamId: string }) {
  const lo = useApi<{ loadout: null | { name: string; items: LoItem[] } }>(`/players/${steamId}/loadout`);
  const items = lo.data?.loadout?.items ?? [];
  if (!lo.data?.loadout) return null;
  const order = ['AGENT', 'KNIFE', 'GLOVES'];
  const sorted = [...items].sort((a, b) => (order.indexOf(a.item.slot) + 1 || 99) - (order.indexOf(b.item.slot) + 1 || 99) || a.item.slot.localeCompare(b.item.slot));
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-lg font-bold">Loadout <span className="text-sm font-normal text-muted">· {lo.data.loadout.name}</span></h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {sorted.map((e) => {
          const s = e.item.skin;
          const isAgent = e.item.slot === 'AGENT';
          return (
            <div key={`${e.weaponDefIndex}-${e.team}`} className="relative flex flex-col overflow-hidden rounded-md border bg-card" style={{ borderBottom: `3px solid ${RARITY[s?.rarity ?? ''] ?? '#888'}` }}>
              <span className="absolute left-1.5 top-1.5 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">{SIDE_LABEL[e.team]}</span>
              <div className="flex h-20 items-center justify-center bg-elevated p-2">{s?.imageUrl && <img src={`${s.imageUrl}/192fx144f`} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />}</div>
              <div className="p-2"><div className="truncate text-sm font-semibold">{isAgent ? s?.weaponName : `${s?.weaponName ?? ''} | ${s?.name || 'Vanilla'}${s?.phase ? ' · ' + s.phase : ''}`}</div>
                {!isAgent && <div className="text-xs text-muted">{e.item.float.toFixed(3)} · Pattern {e.item.pattern}{e.item.statTrak ? ' · StatTrak' : ''}</div>}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

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
      <PublicLoadout steamId={steamId} />
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
