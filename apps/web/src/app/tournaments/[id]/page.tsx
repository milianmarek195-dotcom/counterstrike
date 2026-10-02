'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, Loading, PageTitle, StatusBadge } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, FORMAT_LABEL } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface T {
  id: string; name: string; description: string | null; rules: string | null; status: string; format: string; teamSize: number; maxTeams: number; teamCount: number; bestOf: number; bestOfFinal: number | null;
  registrationOpen: boolean; requiresPassword: boolean; startsAt: string; minElo: number | null; maxElo: number | null;
  mapPool: { name: string; maps: Array<{ id: string; name: string }> };
  teams: Array<{ id: string; name: string; seed: number | null; placement: number | null }>;
  viewer: { registered: boolean } | null;
}
interface Node { key: string; side: string; round: number; label: string; isBye: boolean; matchId: string | null; status: string; teamA: { name: string } | null; teamB: { name: string } | null; scoreA: number | null; scoreB: number | null; winnerId: string | null; map: string | null }

export default function TournamentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { me, login } = useAuth();
  const t = useApi<T>(`/tournaments/${id}`);
  const b = useApi<{ nodes: Node[] }>(t.data && t.data.status !== 'DRAFT' ? `/tournaments/${id}/bracket` : null);
  const reload = () => { t.reload(); b.reload(); };
  useRealtime('tournament', id, reload);
  const act = useAction(reload);
  const [password, setPassword] = useState('');
  if (t.loading && !t.data) return <Loading />;
  if (t.error) return <ErrorBox message={t.error.status === 404 ? 'Turnier nicht gefunden.' : t.error.message} />;
  const d = t.data!;
  const registered = d.viewer?.registered;
  return (
    <>
      <PageTitle title={d.name} subtitle={`${FORMAT_LABEL[d.format]} · ${d.teamSize}v${d.teamSize} · BO${d.bestOf}${d.bestOfFinal ? ` (Finale BO${d.bestOfFinal})` : ''} · Start ${fmtDate(d.startsAt)}`} actions={<StatusBadge status={d.status} />} />
      {d.description && <p className="mb-4 text-sm text-muted">{d.description}</p>}
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-2 font-semibold">Anmeldung</h2>
          <p className="text-sm text-muted">{d.teamCount}/{d.maxTeams} Teams{d.minElo ? ` · min. Elo ${d.minElo}` : ''}{d.maxElo ? ` · max. Elo ${d.maxElo}` : ''}</p>
          {d.registrationOpen ? (
            me.user ? (
              registered ? <Button className="mt-3" variant="secondary" disabled={act.busy} onClick={() => void act.run(() => api(`/tournaments/${id}/register`, { method: 'DELETE' }))}>Abmelden</Button> : (
                <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void act.run(() => api(`/tournaments/${id}/register`, { method: 'POST', body: password ? { password } : {} })); }}>
                  {d.requiresPassword && <Input label="Passwort" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />}
                  <Button disabled={act.busy}>Anmelden</Button>
                </form>
              )
            ) : <Button className="mt-3" onClick={() => login(`/tournaments/${id}`)}>Mit Steam anmelden</Button>
          ) : <p className="mt-2 text-sm text-muted">Die Anmeldung ist geschlossen.</p>}
          {act.error && <div className="mt-2"><ErrorBox message={act.error} /></div>}
        </Card>
        <Card>
          <h2 className="mb-2 font-semibold">Map-Pool: {d.mapPool.name}</h2>
          <p className="text-sm text-muted">{d.mapPool.maps.map((m) => m.name).join(', ')}</p>
        </Card>
      </div>
      {d.rules && <Card className="mb-6 whitespace-pre-wrap text-sm"><h2 className="mb-2 font-semibold">Regeln</h2>{d.rules}</Card>}

      <h2 className="mb-3 text-lg font-bold">Teams</h2>
      {!d.teams.length ? <Empty>Noch keine Teams angemeldet.</Empty> : <div className="mb-8 flex flex-wrap gap-2">{d.teams.map((x) => <span key={x.id} className="rounded-lg border bg-card px-3 py-1.5 text-sm">{x.seed ? `#${x.seed} ` : ''}{x.name}{x.placement ? ` · Platz ${x.placement}` : ''}</span>)}</div>}

      {b.data && b.data.nodes.length > 0 && <Bracket nodes={b.data.nodes} />}
    </>
  );
}

function Bracket({ nodes }: { nodes: Node[] }) {
  const sides = [...new Set(nodes.map((n) => n.side))];
  return (
    <section>
      <h2 className="mb-3 text-lg font-bold">Bracket</h2>
      {sides.map((side) => {
        const rounds = [...new Set(nodes.filter((n) => n.side === side).map((n) => n.round))].sort((a, b) => a - b);
        return (
          <div key={side} className="mb-6">
            {sides.length > 1 && <h3 className="mb-2 text-sm font-semibold uppercase text-muted">{side}</h3>}
            <div className="flex gap-6 overflow-x-auto pb-2">
              {rounds.map((r) => (
                <div key={r} className="flex min-w-52 flex-col justify-around gap-3">
                  {nodes.filter((n) => n.side === side && n.round === r).map((n) => <NodeCard key={n.key} n={n} />)}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function NodeCard({ n }: { n: Node }) {
  const row = (name: string | undefined, score: number | null) => <div className="flex justify-between gap-2"><span className={name ? '' : 'text-muted'}>{name ?? 'TBD'}</span><b>{score ?? ''}</b></div>;
  const body = (
    <div className={`rounded-lg border bg-card p-2 text-sm ${n.isBye ? 'opacity-50' : 'hover:bg-card-hover'}`}>
      <div className="mb-1 flex justify-between text-xs text-muted"><span>{n.label}</span><span>{n.isBye ? 'Freilos' : n.status === 'LIVE' ? '● LIVE' : n.map ?? ''}</span></div>
      {row(n.teamA?.name, n.scoreA)}{row(n.teamB?.name, n.scoreB)}
    </div>
  );
  return n.matchId ? <Link href={`/matches/${n.matchId}`}>{body}</Link> : body;
}
