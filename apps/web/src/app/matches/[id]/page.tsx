'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, Loading, PageTitle, RankBadge, Select, StatusBadge, Table } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { fmtDate, fmtNum } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface Player { userId: string; steamId: string; displayName: string; isCaptain: boolean; isSubstitute: boolean; connected: boolean; removed: boolean; elo: number | null; rank: { name: string; color: string } | null; eloDelta: number | null }
interface Team { slot: 'A' | 'B'; name: string; seriesScore: number; maxPlayers: number; averageElo: number; players: Player[] }
interface MatchView {
  id: string; kind: string; status: string; displayStatus: string; bestOf: number; paused: boolean; winnerSlot: string | null; startedAt: string | null; finishedAt: string | null; cancelReason: string | null;
  controller: { displayName: string } | null; tournament: { id: string; name: string } | null;
  teams: { A: Team; B: Team }; unassigned: Player[];
  maps: Array<{ mapNumber: number; status: string; scoreA: number; scoreB: number; map: { id: string; name: string } }>;
  server: { name: string; address: string; connect: string } | null;
  viewer: { canControl: boolean; role: string | null; slot: 'A' | 'B' | null } | null;
}
interface Veto { complete: boolean; startsWith: 'A' | 'B'; deadline?: string | null; current: { stepIndex: number; team: 'A' | 'B'; action: string } | null; remaining: Array<{ id: string; name: string }>; steps: Array<{ index: number; action: string; team: string | null }>; actions: Array<{ team: string; action: string; map: { id?: string; name: string } | null; side: string | null }> }
interface Row { steamId: string; displayName: string; team: string; kills: number; deaths: number; assists: number; kd: number; adr: number; hsPercent: number; mvps: number; killsAwp: number; killsAk47: number; killsPistol: number }

export default function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const m = useApi<MatchView>(`/matches/${id}`);
  const veto = useApi<Veto>(m.data && ['VETO', 'MAP_FORCED'].includes(m.data.status) ? `/matches/${id}/veto` : null);
  const board = useApi<{ total: Row[] }>(m.data && ['LIVE', 'FINISHED'].includes(m.data.status) ? `/matches/${id}/scoreboard` : null);
  const reloadAll = () => { m.reload(); veto.reload(); board.reload(); };
  useRealtime('match', id, reloadAll);

  if (m.loading && !m.data) return <Loading />;
  if (m.error) return <ErrorBox message={m.error.message} />;
  const v = m.data!;
  return (
    <>
      <PageTitle title={`${v.teams.A.name} vs ${v.teams.B.name}`} subtitle={`${v.tournament ? v.tournament.name : v.kind === 'CUSTOM' ? 'Party-Match' : v.kind} · BO${v.bestOf} · ${fmtDate(v.finishedAt ?? v.startedAt)}`} actions={<StatusBadge status={v.status} />} />
      <Card className="mb-6 text-center">
        <div className="text-4xl font-extrabold">{v.teams.A.seriesScore} : {v.teams.B.seriesScore}</div>
        <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm text-muted">{v.maps.map((x) => <span key={x.mapNumber}>{x.map.name} {x.scoreA}:{x.scoreB}</span>)}</div>
        {v.paused && <p className="mt-2 text-sm font-semibold text-warning">Match pausiert</p>}
        {v.cancelReason && <p className="mt-2 text-sm text-danger">Abgebrochen: {v.cancelReason}</p>}
      </Card>

      {v.server && (
        <Card className="mb-6 flex flex-wrap items-center justify-between gap-3 border-primary/50">
          <div><div className="text-sm text-muted">Server</div><div className="font-semibold">{v.server.name} · {v.server.address}</div></div>
          <a href={v.server.connect} className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-fg hover:opacity-90">MIT SERVER VERBINDEN</a>
        </Card>
      )}

      {v.viewer?.canControl && <ControlPanel match={v} reload={reloadAll} />}
      {veto.data && !veto.data.complete && <VetoPanel matchId={id} veto={veto.data} match={v} reload={reloadAll} />}

      <div className="grid gap-4 md:grid-cols-2">
        {(['A', 'B'] as const).map((s) => <TeamCard key={s} team={v.teams[s]} />)}
      </div>

      {board.data && board.data.total.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-bold">Scoreboard</h2>
          <Table head={['Spieler', 'Team', 'K', 'D', 'A', 'AWP', 'AK-47', 'Pistole', 'K/D', 'ADR', 'HS %', 'MVP']}>
            {board.data.total.map((r) => (
              <tr key={r.steamId}><td className="px-3 py-2"><Link className="hover:text-primary" href={`/players/${r.steamId}`}>{r.displayName}</Link></td><td className="px-3 py-2">{r.team}</td><td className="px-3 py-2">{r.kills}</td><td className="px-3 py-2">{r.deaths}</td><td className="px-3 py-2">{r.assists}</td><td className="px-3 py-2">{r.killsAwp}</td><td className="px-3 py-2">{r.killsAk47}</td><td className="px-3 py-2">{r.killsPistol}</td><td className="px-3 py-2">{fmtNum(r.kd, 2)}</td><td className="px-3 py-2">{fmtNum(r.adr, 1)}</td><td className="px-3 py-2">{fmtNum(r.hsPercent, 1)}</td><td className="px-3 py-2">{r.mvps}</td></tr>
            ))}
          </Table>
        </section>
      )}
    </>
  );
}

function TeamCard({ team }: { team: Team }) {
  return (
    <Card>
      <div className="mb-2 flex items-baseline justify-between"><h2 className="font-bold">{team.name}</h2><span className="text-xs text-muted">{team.players.filter((p) => !p.removed).length}/{team.maxPlayers} · Ø Elo {team.averageElo}</span></div>
      <ul className="space-y-1">
        {team.players.filter((p) => !p.removed).map((p) => (
          <li key={p.userId} className="flex items-center justify-between text-sm">
            <Link href={`/players/${p.steamId}`} className="hover:text-primary">{p.displayName}{p.isCaptain && ' ©'}{p.isSubstitute && ' (Sub)'}</Link>
            <span className="flex items-center gap-2"><RankBadge rank={p.rank} />{p.eloDelta !== null && <span className={p.eloDelta >= 0 ? 'text-success' : 'text-danger'}>{p.eloDelta > 0 ? '+' : ''}{p.eloDelta}</span>}{p.connected && <span className="text-xs text-success">● online</span>}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function useSecondsLeft(deadline: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  return deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000)) : null;
}

/** HLTV/ESL-style veto: team banners, step track, map cards that show who banned / picked what, side choice, countdown. */
function VetoPanel({ matchId, veto, match, reload }: { matchId: string; veto: Veto; match: MatchView; reload: () => void }) {
  const act = useAction(reload);
  const cur = veto.current;
  const left = useSecondsLeft(veto.deadline ?? null);
  const mine = !!cur && (match.viewer?.slot === cur.team || !!match.viewer?.canControl);
  const teamName = (slot: string | null) => (slot === 'A' || slot === 'B' ? match.teams[slot].name : '–');
  const verb: Record<string, string> = { BAN: 'bannt', PICK: 'pickt', SIDE: 'wählt die Seite', DECIDER: 'Decider' };
  const stepText: Record<string, string> = { BAN: 'Ban', PICK: 'Pick', SIDE: 'Seite', DECIDER: 'Decider' };

  // all maps of the pool: still available + already used by a step
  const used = new Map<string, { team: string | null; action: string; side: string | null; name: string }>();
  for (const x of veto.actions) {
    if (!x.map || !x.map.id) continue;
    const prev = used.get(x.map.id);
    if (x.action === 'SIDE') { if (prev) prev.side = x.side; continue; }
    used.set(x.map.id, { team: x.team, action: x.action, side: x.side, name: x.map.name });
  }
  const cards = [
    ...veto.remaining.map((r) => ({ id: r.id, name: r.name, state: null as null | { team: string | null; action: string; side: string | null } })),
    ...[...used.entries()].map(([id, u]) => ({ id, name: u.name, state: u })),
  ];
  const choosing = mine && !!cur && cur.action !== 'SIDE';

  return (
    <Card className="mb-6">
      <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        {(['A', 'B'] as const).map((slot, i) => (
          <div key={slot} className={`${i === 1 ? 'order-3 text-right' : ''} rounded-md border-l-4 px-3 py-2 ${cur?.team === slot ? 'border-primary bg-primary/10' : 'border-transparent bg-card-hover'}`}>
            <div className="font-display text-lg font-bold uppercase leading-none">{match.teams[slot].name}</div>
            <div className="mt-1 text-xs text-muted">{cur?.team === slot ? (match.viewer?.slot === slot ? 'Du bist dran' : 'ist dran') : veto.startsWith === slot ? 'beginnt' : 'wartet'}</div>
          </div>
        ))}
        <div className="order-2 text-center">
          <div className="font-display text-xs uppercase tracking-widest text-muted">Map-Veto · BO{match.bestOf}</div>
          {left !== null && !veto.complete && <div className={`font-display text-3xl font-bold tabular-nums ${left <= 10 ? 'text-primary' : ''}`}>{left}s</div>}
        </div>
      </div>

      <ol className="mb-4 flex flex-wrap gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
        {veto.steps.map((st) => {
          const done = st.index < (cur?.stepIndex ?? 1e9);
          const active = cur?.stepIndex === st.index;
          return <li key={st.index} className={`rounded px-2 py-1 ${active ? 'bg-primary text-primary-fg' : done ? 'bg-card-hover text-muted line-through' : 'border text-muted'}`}>{stepText[st.action]}{st.team ? ' ' + teamName(st.team).slice(0, 10) : ''}</li>;
        })}
      </ol>

      {cur ? (
        <p className="mb-3 text-sm"><b>{teamName(cur.team)}</b> {verb[cur.action]}{cur.action === 'SIDE' ? ' (CT oder T)' : cur.action !== 'DECIDER' ? ' – wähle eine Map' : ''}.</p>
      ) : <p className="mb-3 text-sm text-muted">Das Veto hat noch nicht begonnen.</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {cards.map((c) => {
          const st = c.state;
          const banned = st?.action === 'BAN';
          const picked = st?.action === 'PICK' || st?.action === 'DECIDER';
          const clickable = choosing && !st && !act.busy;
          return (
            <button key={c.id} disabled={!clickable} onClick={() => cur && void act.run(() => api(`/matches/${matchId}/veto`, { method: 'POST', body: { action: cur.action, mapId: c.id } }))}
              className={`stripes relative flex h-24 flex-col justify-end overflow-hidden rounded-lg border p-3 text-left transition ${picked ? 'border-primary ring-2 ring-primary' : ''} ${banned ? 'opacity-45 grayscale' : ''} ${clickable ? 'cursor-pointer hover:border-primary hover:brightness-125' : 'cursor-default'}`}>
              <span className={`font-display text-xl font-bold uppercase leading-none ${banned ? 'line-through' : ''}`}>{c.name}</span>
              <span className="mt-1 text-[11px] uppercase tracking-wide text-muted">
                {!st ? (clickable ? (cur?.action === 'BAN' ? 'Klicken zum Bannen' : 'Klicken zum Picken') : 'Verfügbar') : banned ? `Ban · ${teamName(st.team)}` : st.action === 'DECIDER' ? `Decider${st.side ? ' · ' + st.side : ''}` : `Pick · ${teamName(st.team)}${st.side ? ' · Gegner: ' + st.side : ''}`}
              </span>
              {picked && <span className="absolute right-2 top-2 rounded bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-fg">{st.action === 'DECIDER' ? 'DECIDER' : 'PICK'}</span>}
            </button>
          );
        })}
      </div>

      {mine && cur?.action === 'SIDE' && (
        <div className="mt-4 flex items-center gap-3"><span className="text-sm">Startseite:</span>
          {(['CT', 'T'] as const).map((sd) => <Button key={sd} disabled={act.busy} onClick={() => void act.run(() => api(`/matches/${matchId}/veto`, { method: 'POST', body: { action: 'SIDE', side: sd } }))}>{sd === 'CT' ? 'Counter-Terrorist' : 'Terrorist'}</Button>)}
        </div>
      )}
      {act.error && <div className="mt-2"><ErrorBox message={act.error} /></div>}
    </Card>
  );
}

/** Same rights for admins and the party leader: team assignment (buttons + drag and drop), map force, server, start/stop, pause. */
function ControlPanel({ match, reload }: { match: MatchView; reload: () => void }) {
  const act = useAction(reload);
  const base = `/matches/${match.id}/control`;
  const post = (path: string, body: object = {}) => void act.run(() => api(`${base}/${path}`, { method: 'POST', body }));
  const maps = useApi<{ maps: Array<{ id: string; name: string }> }>('/maps');
  const servers = useApi<{ servers: Array<{ id: string; name: string; status: string }> }>('/servers');
  const [mapId, setMapId] = useState('');
  const [serverId, setServerId] = useState('');
  const [reason, setReason] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const setup = ['WAITING', 'LOBBY', 'VETO', 'MAP_FORCED'].includes(match.status);
  const running = ['CONFIGURING', 'LIVE'].includes(match.status);
  const all: Array<{ p: Player; team: 'A' | 'B' | null }> = [
    ...match.unassigned.map((p) => ({ p, team: null })),
    ...(['A', 'B'] as const).flatMap((s) => match.teams[s].players.filter((p) => !p.removed).map((p) => ({ p, team: s as 'A' | 'B' }))),
  ];
  const move = (userId: string, team: 'A' | 'B' | null) => void act.run(() => api(`${base}/assign-team`, { method: 'POST', body: { userId, team } }));
  const Column = ({ team, label }: { team: 'A' | 'B' | null; label: string }) => (
    <div className="min-h-24 rounded-lg border border-dashed p-2" onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag) move(drag, team); setDrag(null); }}>
      <div className="mb-1 text-xs font-semibold uppercase text-muted">{label}</div>
      {all.filter((x) => x.team === team).map(({ p }) => (
        <div key={p.userId} draggable onDragStart={() => setDrag(p.userId)} className="mb-1 flex cursor-grab items-center justify-between gap-1 rounded-md bg-elevated px-2 py-1 text-sm">
          <span>{p.displayName}</span>
          <span className="flex gap-1">
            {(['A', 'B', null] as const).filter((t) => t !== team).map((t) => <button key={String(t)} disabled={!setup || act.busy} onClick={() => move(p.userId, t)} className="rounded border px-1.5 text-xs hover:bg-card-hover disabled:opacity-40" aria-label={`${p.displayName} nach ${t ?? 'Ohne Team'}`}>{t ?? '–'}</button>)}
          </span>
        </div>
      ))}
    </div>
  );
  return (
    <Card className="mb-6 border-accent/50">
      <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">Match-Steuerung</h2><span className="text-xs text-muted">Rolle: {match.viewer?.role === 'ADMIN' ? 'Admin' : 'Party-Leader'}</span></div>
      <div className="mb-4 grid gap-2 md:grid-cols-3">
        <Column team={null} label="Ohne Team" /><Column team="A" label={`Team A (${match.teams.A.maxPlayers})`} /><Column team="B" label={`Team B (${match.teams.B.maxPlayers})`} />
      </div>
      {!setup && <p className="mb-3 text-xs text-muted">Teams und Map können nur in der Setup-Phase geändert werden.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex items-end gap-2"><Select label="Map erzwingen" value={mapId} onChange={(e) => setMapId(e.target.value)}><option value="">– wählen –</option>{maps.data?.maps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select><Button disabled={!mapId || !setup || act.busy} onClick={() => post('force-map', { mapId })}>Setzen</Button></div>
        <div className="flex items-end gap-2"><Select label="Server zuweisen" value={serverId} onChange={(e) => setServerId(e.target.value)}><option value="">– wählen –</option>{servers.data?.servers.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.status})</option>)}</Select><Button disabled={!serverId || !setup || act.busy} onClick={() => post('assign-server', { serverId })}>Zuweisen</Button></div>
      </div>
      <div className="mt-3"><Input label="Grund (optional, wird im Audit-Log gespeichert)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!setup || act.busy} onClick={() => post('start-veto')}>Veto starten</Button>
        <Button variant="secondary" disabled={match.status !== 'VETO' || act.busy} onClick={() => post('skip-veto')}>Veto überspringen</Button>
        <Button disabled={!['MAP_FORCED', 'LOBBY'].includes(match.status) || act.busy} onClick={() => post('start')}>Match starten</Button>
        <Button variant="secondary" disabled={!running || act.busy} onClick={() => post(match.paused ? 'unpause' : 'pause', reason ? { reason } : {})}>{match.paused ? 'Fortsetzen' : 'Pausieren'}</Button>
        <Button variant="secondary" disabled={!running || act.busy} onClick={() => post('restart', reason ? { reason } : {})}>Neustart</Button>
        <Button variant="danger" disabled={['FINISHED', 'CANCELLED'].includes(match.status) || act.busy} onClick={() => { if (confirm('Match wirklich beenden?')) post('end', reason ? { reason } : {}); }}>Match beenden</Button>
      </div>
      {act.error && <div className="mt-3"><ErrorBox message={act.error} /></div>}
      {match.kind === 'TOURNAMENT' && <Empty>Turnier-Matches: Teamzuordnung kommt aus der Turnierregistrierung.</Empty>}
    </Card>
  );
}
