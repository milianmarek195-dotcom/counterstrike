'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface T { id: string; name: string; tag: string | null; members: number }

export default function Teams() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const list = useApi<{ teams: T[] }>(`/teams?pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const mine = useApi<{ teamIds: string[]; invites: Array<{ id: string; team: { name: string }; invitedBy: string }> }>(me.user ? '/teams/me' : null);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const create = useAction(() => { setName(''); setTag(''); list.reload(); mine.reload(); });
  const respond = useAction(() => { list.reload(); mine.reload(); });
  return (
    <>
      <PageTitle title="Teams" actions={<div className="w-56"><Input aria-label="Suche" placeholder="Team suchen …" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
      {mine.data?.invites.map((i) => (
        <Card key={i.id} className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{i.invitedBy} lädt dich in <b>{i.team.name}</b> ein.</span>
          <span className="flex gap-2">
            <Button disabled={respond.busy} onClick={() => void respond.run(() => api(`/teams/invites/${i.id}/accept`, { method: 'POST' }))}>Annehmen</Button>
            <Button variant="secondary" disabled={respond.busy} onClick={() => void respond.run(() => api(`/teams/invites/${i.id}/decline`, { method: 'POST' }))}>Ablehnen</Button>
          </span>
        </Card>
      ))}
      {respond.error && <ErrorBox message={respond.error} />}
      {list.loading ? <Loading /> : !list.data?.teams.length ? <Empty>Keine Teams gefunden.</Empty> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.data.teams.map((t) => (
            <Link key={t.id} href={`/teams/${t.id}`}><Card className="hover:bg-card-hover"><div className="font-semibold">{t.name} {t.tag && <span className="text-muted">[{t.tag}]</span>}</div><div className="text-xs text-muted">{t.members} Mitglieder</div></Card></Link>
          ))}
        </div>
      )}
      {me.user && (
        <Card className="mt-8 max-w-md">
          <h2 className="mb-3 font-semibold">Team gründen</h2>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void create.run(() => api('/teams', { method: 'POST', body: { name, ...(tag ? { tag } : {}) } })); }}>
            <Input label="Name" required minLength={3} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
            <Input label="Tag (2–6 Zeichen, optional)" maxLength={6} value={tag} onChange={(e) => setTag(e.target.value)} />
            {create.error && <ErrorBox message={create.error} />}
            <Button disabled={create.busy}>Gründen</Button>
          </form>
        </Card>
      )}
    </>
  );
}
