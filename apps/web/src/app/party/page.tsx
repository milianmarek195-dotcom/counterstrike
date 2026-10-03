'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle, Select } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Party {
  party: null | { id: string; status: string; isLeader: boolean; members: Array<{ id: string; displayName: string; isLeader: boolean }>; invites?: Array<{ invitee: { displayName: string } }>; activeMatch: null | { id: string; status: string } };
  invites: Array<{ id: string; from: { displayName: string } }>;
}

interface Found { players: Array<{ steamId: string; displayName: string; avatarUrl: string | null }> }
interface Friends { available: boolean; reason?: string; friends: Array<{ steamId: string; displayName: string; avatarUrl: string | null }> }

/** Invite by username (search) or from the Steam friend list. */
function InvitePanel({ memberNames, pendingNames, busy, onInvite, onForce }: { memberNames: string[]; pendingNames: string[]; busy: boolean; onInvite: (steamId: string) => void; onForce?: (steamId: string) => void }) {
  const [name, setName] = useState('');
  const term = name.trim();
  const found = useApi<Found>(term.length >= 2 ? `/players?q=${encodeURIComponent(term)}&pageSize=8` : null);
  const friends = useApi<Friends>('/parties/friends');
  const taken = new Set([...memberNames, ...pendingNames]);
  const row = (p: { steamId: string; displayName: string }) => (
    <li key={p.steamId} className="flex items-center justify-between py-1.5 text-sm">
      <span>{p.displayName}</span>
      {memberNames.includes(p.displayName) ? <span className="text-xs text-muted">in der Party</span> : (
        <span className="flex gap-1">
          {!taken.has(p.displayName) && <Button disabled={busy} onClick={() => onInvite(p.steamId)}>Einladen</Button>}
          {onForce && <Button variant="secondary" disabled={busy} title="Direkt in die Party setzen, ohne dass die Person annehmen muss" onClick={() => onForce(p.steamId)}>Direkt hinzufügen</Button>}
        </span>
      )}
    </li>
  );
  return (
    <div className="mt-4 space-y-4">
      <div>
        <Input label="Spieler per Username einladen" placeholder="Name suchen …" value={name} onChange={(e) => setName(e.target.value)} />
        {term.length >= 2 && <ul className="mt-1 divide-y">{found.data?.players.length ? found.data.players.map(row) : <li className="py-1.5 text-sm text-muted">{found.loading ? 'Suche …' : 'Niemand gefunden.'}</li>}</ul>}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Steam-Freunde</h3>
        {friends.loading && !friends.data ? <p className="text-sm text-muted">Lade …</p>
          : !friends.data?.available ? <p className="text-sm text-muted">{friends.data?.reason === 'PRIVATE' ? 'Deine Steam-Freundesliste ist privat. Stelle sie in den Steam-Datenschutzeinstellungen auf öffentlich, um Freunde hier zu sehen.' : 'Steam-Freunde sind gerade nicht abrufbar.'}</p>
          : friends.data.friends.length ? <ul className="divide-y">{friends.data.friends.map(row)}</ul> : <p className="text-sm text-muted">Keiner deiner Steam-Freunde ist hier registriert.</p>}
      </div>
    </div>
  );
}

/** Website-first flow: party → players → (in the match) teams → map → server → connect. */
export default function PartyPage() {
  const { me, login, can } = useAuth();
  const q = useApi<Party>(me.user ? '/parties/me' : null);
  const act = useAction(q.reload);
    const [a, setA] = useState(5);
  const [b, setB] = useState(5);
  const [bestOf, setBestOf] = useState(1);
  const post = (path: string, body?: object, method = 'POST') => void act.run(() => api(`/parties${path}`, { method, body }));
  if (!me.user) return <><PageTitle title="Party" /><Card><p className="mb-3 text-sm text-muted">Melde dich an, um mit Freunden ein eigenes Match zu starten.</p><Button onClick={() => login('/party')}>Mit Steam anmelden</Button></Card></>;
  if (q.loading && !q.data) return <Loading />;
  const p = q.data?.party;
  return (
    <>
      <PageTitle title="Party" subtitle="Lade Spieler ein, öffne ein Match und teile sie auf Team A und B auf – beliebige Teamgrößen." />
      {q.data?.invites.map((i) => (
        <Card key={i.id} className="mb-3 flex items-center justify-between gap-2"><span className="text-sm">{i.from.displayName} lädt dich in eine Party ein.</span><span className="flex gap-2"><Button onClick={() => post(`/invites/${i.id}/accept`)}>Annehmen</Button><Button variant="secondary" onClick={() => post(`/invites/${i.id}/decline`)}>Ablehnen</Button></span></Card>
      ))}
      {act.error && <ErrorBox message={act.error} />}
      {!p ? <Button disabled={act.busy} onClick={() => post('')}>Party erstellen</Button> : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <h2 className="mb-2 font-semibold">Mitglieder</h2>
            <ul className="divide-y text-sm">{p.members.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2"><span>{m.displayName} {m.isLeader && <b className="text-primary">Leader</b>}</span>
                {p.isLeader && !m.isLeader && <span className="flex gap-1"><Button variant="secondary" onClick={() => post('/transfer-leadership', { userId: m.id })}>Leader</Button><Button variant="danger" onClick={() => post('/kick', { userId: m.id })}>Kick</Button></span>}</li>
            ))}</ul>
            {p.isLeader && <InvitePanel busy={act.busy} memberNames={p.members.map((m) => m.displayName)} pendingNames={p.invites?.map((i) => i.invitee.displayName) ?? []} onInvite={(steamId) => post('/invite', { steamId })} onForce={can('admin.access') ? (steamId) => post('/force-add', { steamId }) : undefined} />}
            <div className="mt-4 flex gap-2"><Button variant="secondary" onClick={() => post('/leave')}>Verlassen</Button>{p.isLeader && <Button variant="danger" onClick={() => { if (confirm('Party auflösen?')) post('', undefined, 'DELETE'); }}>Auflösen</Button>}</div>
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">Match</h2>
            {p.activeMatch ? (
              <><p className="mb-3 text-sm text-muted">Aktives Match: {p.activeMatch.status}</p><Link href={`/matches/${p.activeMatch.id}`} className="inline-flex rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-fg">Zum Match / Steuerung</Link></>
            ) : p.isLeader ? (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { const r = await api<{ matchId: string }>('/parties/match', { method: 'POST', body: { teamAMax: a, teamBMax: b, bestOf } }); window.location.href = `/matches/${r.matchId}`; }); }}>
                <div className="grid grid-cols-2 gap-3"><Input label="Team A max." type="number" min={1} max={16} value={a} onChange={(e) => setA(Number(e.target.value))} /><Input label="Team B max." type="number" min={1} max={16} value={b} onChange={(e) => setB(Number(e.target.value))} /></div>
                <Select label="Best of" value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}><option value={1}>BO1</option><option value={3}>BO3</option><option value={5}>BO5</option></Select>
                <Button disabled={act.busy}>Match erstellen</Button>
              </form>
            ) : <p className="text-sm text-muted">Nur der Party-Leader kann ein Match erstellen.</p>}
          </Card>
        </div>
      )}
    </>
  );
}
