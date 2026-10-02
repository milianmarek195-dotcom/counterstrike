'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';

interface Team { id: string; name: string; tag: string | null; captainId: string; members: Array<{ userId: string; displayName: string; role: string; elo: number | null }>; viewer: { isCaptain: boolean; isMember: boolean } | null }

export default function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const t = useApi<Team>(`/teams/${id}`);
  const act = useAction(t.reload);
  const [steamId, setSteamId] = useState('');
  if (t.loading && !t.data) return <Loading />;
  if (t.error) return <ErrorBox message={t.error.message} />;
  const team = t.data!;
  const cap = team.viewer?.isCaptain;
  const call = (path: string, body?: object, method = 'POST') => void act.run(() => api(`/teams/${id}${path}`, { method, body }));
  return (
    <>
      <PageTitle title={team.name} subtitle={team.tag ? `[${team.tag}]` : undefined} />
      <Card>
        <ul className="divide-y">
          {team.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>{m.displayName} {m.role === 'CAPTAIN' && <b className="text-primary">Kapitän</b>} <span className="text-muted">Elo {m.elo ?? '–'}</span></span>
              {cap && m.userId !== team.captainId && <span className="flex gap-2"><Button variant="secondary" onClick={() => call('/captain', { userId: m.userId })}>Zum Kapitän</Button><Button variant="danger" onClick={() => call('/kick', { userId: m.userId })}>Entfernen</Button></span>}
            </li>
          ))}
        </ul>
      </Card>
      {cap && (
        <Card className="mt-4 max-w-md">
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); call('/invite', { steamId }); setSteamId(''); }}>
            <Input label="SteamID64 einladen" pattern="7656119\d{10}" required value={steamId} onChange={(e) => setSteamId(e.target.value)} /><Button disabled={act.busy}>Einladen</Button>
          </form>
          <Button variant="danger" className="mt-4" onClick={() => { if (confirm('Team wirklich auflösen?')) void act.run(async () => { await api(`/teams/${id}`, { method: 'DELETE' }); router.push('/teams'); }); }}>Team auflösen</Button>
        </Card>
      )}
      {team.viewer?.isMember && !cap && <Button className="mt-4" variant="secondary" onClick={() => void act.run(async () => { await api(`/teams/${id}/leave`, { method: 'POST' }); router.push('/teams'); })}>Team verlassen</Button>}
      {act.error && <div className="mt-3"><ErrorBox message={act.error} /></div>}
      <p className="mt-6 text-sm"><Link className="text-primary" href="/teams">← Alle Teams</Link></p>
    </>
  );
}
