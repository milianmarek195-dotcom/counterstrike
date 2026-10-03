'use client';
import Link from 'next/link';
import { LogoMark } from '@/components/logo';
import { Card, Empty, LinkButton, Loading, RankBadge, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, fmtNum, FORMAT_LABEL } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface Tournament { id: string; name: string; status: string; format: string; teamSize: number; maxTeams: number; teamCount: number; startsAt: string; registrationOpen: boolean }
interface MatchRow { id: string; status: string; teams: { A: { name: string; score: number }; B: { name: string; score: number } }; map: { name: string; scoreA: number; scoreB: number } | null; tournament: { name: string } | null }
interface RankRow { position: number; steamId: string; displayName: string; elo: number; rank: { name: string; color: string; key?: string } }
interface Tier { key: string; position: number }

export default function Home() {
  const t = useApi<{ tournaments: Tournament[] }>('/tournaments?pageSize=4');
  const m = useApi<{ matches: MatchRow[] }>('/matches?pageSize=6');
  const r = useApi<{ entries: RankRow[] }>('/ranking?pageSize=5');
  const tiers = useApi<{ tiers: Tier[] }>('/ranking/tiers');
  useRealtime('live', undefined, () => m.reload());
  const level = (key?: string) => tiers.data?.tiers.find((x) => x.key === key)?.position;
  return (
    <div className="space-y-10">
      <section className="stripes relative overflow-hidden rounded-lg border bg-gradient-to-br from-card via-elevated to-card p-8 md:p-12">
        <LogoMark size={260} className="pointer-events-none absolute -right-10 -top-6 hidden text-fg opacity-[0.06] md:block" />
        <p className="font-display text-sm font-bold uppercase tracking-[0.25em] text-primary">Competitive CS2</p>
        <h1 className="mt-2 max-w-2xl text-4xl leading-none md:text-6xl">Spiel auf <span className="text-primary">höchstem Niveau</span></h1>
        <p className="mt-4 max-w-xl text-muted">Melde dich mit Steam an, tritt Turnieren bei, starte Matches mit deiner Party und sammle Elo für deinen Rang. Skins nimmst du in deinen Loadout mit.</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <LinkButton href="/tournaments">Turniere ansehen</LinkButton>
          <LinkButton href="/party" variant="secondary">Eigenes Match starten</LinkButton>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between"><h2 className="text-2xl">Kommende Turniere</h2><Link className="text-sm font-semibold text-primary hover:underline" href="/tournaments">Alle ansehen</Link></div>
        {t.loading ? <Loading /> : !t.data?.tournaments.length ? <Empty>Noch keine Turniere.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2">
            {t.data.tournaments.map((x) => (
              <Link key={x.id} href={`/tournaments/${x.id}`}>
                <Card className="border-l-4 border-l-primary transition hover:bg-card-hover">
                  <div className="flex items-start justify-between gap-2"><h3 className="text-xl">{x.name}</h3><StatusBadge status={x.status} /></div>
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
          <h2 className="mb-3 text-2xl">Letzte Matches</h2>
          {m.loading ? <Loading /> : !m.data?.matches.length ? <Empty>Noch keine Matches.</Empty> : (
            <div className="space-y-2">
              {m.data.matches.map((x) => (
                <Link key={x.id} href={`/matches/${x.id}`} className="flex items-center justify-between gap-3 rounded-lg border bg-card p-3 transition hover:bg-card-hover">
                  <span className="font-medium">{x.teams.A.name} <b className="mx-1 rounded bg-elevated px-2 py-0.5 font-display text-lg text-primary">{x.teams.A.score} : {x.teams.B.score}</b> {x.teams.B.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted">{x.map?.name}<StatusBadge status={x.status} /></span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <section>
          <div className="mb-3 flex items-end justify-between"><h2 className="text-2xl">Top-Spieler</h2><Link className="text-sm font-semibold text-primary hover:underline" href="/ranking">Rangliste</Link></div>
          {r.loading ? <Loading /> : (
            <Table head={['#', 'Spieler', 'Rang', 'Elo']}>
              {r.data?.entries.map((e) => (
                <tr key={e.steamId} className="hover:bg-card-hover"><td className="px-3 py-2 font-display text-lg font-bold text-muted">{e.position}</td><td className="px-3 py-2 font-semibold"><Link className="hover:text-primary" href={`/players/${e.steamId}`}>{e.displayName}</Link></td><td className="px-3 py-2"><RankBadge rank={e.rank} level={level(e.rank.key)} /></td><td className="px-3 py-2 font-display text-lg font-bold">{fmtNum(e.elo)}</td></tr>
              ))}
            </Table>
          )}
        </section>
      </div>
    </div>
  );
}
