'use client';
import Link from 'next/link';
import { Card, Empty, LinkButton, Loading, RankBadge, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, fmtNum, FORMAT_LABEL } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface Tournament { id: string; name: string; status: string; format: string; teamSize: number; maxTeams: number; teamCount: number; startsAt: string; registrationOpen: boolean }
interface MatchRow { id: string; status: string; teams: { A: { name: string; score: number }; B: { name: string; score: number } }; map: { name: string; scoreA: number; scoreB: number } | null; tournament: { name: string } | null }
interface RankRow { position: number; steamId: string; displayName: string; elo: number; rank: { name: string; color: string } }

export default function Home() {
  const t = useApi<{ tournaments: Tournament[] }>('/tournaments?pageSize=4');
  const m = useApi<{ matches: MatchRow[] }>('/matches?pageSize=6');
  const r = useApi<{ entries: RankRow[] }>('/ranking?pageSize=5');
  useRealtime('live', undefined, () => m.reload());
  return (
    <div className="space-y-10">
      <section className="rounded-2xl border bg-gradient-to-br from-card to-elevated p-8 md:p-12">
        <h1 className="text-3xl font-extrabold tracking-tight md:text-5xl">CS2 Turniere. <span className="text-primary">Dein Rang.</span></h1>
        <p className="mt-3 max-w-xl text-muted">Melde dich mit Steam an, tritt Turnieren bei, starte eigene Matches mit deiner Party und trage deine Skins in den Loadout ein.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <LinkButton href="/tournaments">Turniere ansehen</LinkButton>
          <LinkButton href="/party" variant="secondary">Eigenes Match starten</LinkButton>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-bold">Kommende Turniere</h2>
        {t.loading ? <Loading /> : !t.data?.tournaments.length ? <Empty>Noch keine Turniere.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2">
            {t.data.tournaments.map((x) => (
              <Link key={x.id} href={`/tournaments/${x.id}`}>
                <Card className="transition hover:bg-card-hover">
                  <div className="flex items-start justify-between gap-2"><h3 className="font-semibold">{x.name}</h3><StatusBadge status={x.status} /></div>
                  <p className="mt-1 text-sm text-muted">{FORMAT_LABEL[x.format]} · {x.teamSize}v{x.teamSize} · {x.teamCount}/{x.maxTeams} Teams</p>
                  <p className="mt-1 text-xs text-muted">{fmtDate(x.startsAt)}{x.registrationOpen ? ' · Anmeldung offen' : ''}</p>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-lg font-bold">Letzte Matches</h2>
          {m.loading ? <Loading /> : !m.data?.matches.length ? <Empty>Noch keine Matches.</Empty> : (
            <div className="space-y-2">
              {m.data.matches.map((x) => (
                <Link key={x.id} href={`/matches/${x.id}`} className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3 hover:bg-card-hover">
                  <span className="text-sm font-medium">{x.teams.A.name} <b className="text-primary">{x.teams.A.score}:{x.teams.B.score}</b> {x.teams.B.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">{x.map?.name}<StatusBadge status={x.status} /></span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section>
          <h2 className="mb-3 text-lg font-bold">Top-Spieler</h2>
          {r.loading ? <Loading /> : (
            <Table head={['#', 'Spieler', 'Rang', 'Elo']}>
              {r.data?.entries.map((e) => (
                <tr key={e.steamId}><td className="px-3 py-2">{e.position}</td><td className="px-3 py-2"><Link className="hover:text-primary" href={`/players/${e.steamId}`}>{e.displayName}</Link></td><td className="px-3 py-2"><RankBadge rank={e.rank} /></td><td className="px-3 py-2 font-semibold">{fmtNum(e.elo)}</td></tr>
              ))}
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}
