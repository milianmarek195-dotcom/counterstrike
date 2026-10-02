'use client';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle, Table } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

interface P { id: string; steamId: string; displayName: string; elo: Record<string, number>; roles: Array<{ key: string }> }
interface Detail { id: string; displayName: string; ranks: Array<{ mode: string; elo: number; rank: string }>; bans: Array<{ id: string; reason: string; active: boolean; expiresAt: string | null; createdAt: string }> }

export default function AdminPlayers() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const list = useApi<{ players: P[] }>(`/admin/players?pageSize=25${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const [sel, setSel] = useState<string | null>(null);
  const d = useApi<Detail>(sel ? `/admin/players/${sel}` : null);
  const act = useAction(() => { d.reload(); list.reload(); });
  const [reason, setReason] = useState('');
  const [elo, setElo] = useState('');
  const [hours, setHours] = useState('');
  return (
    <>
      <PageTitle title="Spieler & Bans" actions={<div className="w-56"><Input aria-label="Suche" placeholder="Name oder SteamID …" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {list.loading && !list.data ? <Loading /> : (
            <Table head={['Spieler', 'Elo', 'Rollen']}>
              {list.data?.players.map((p) => <tr key={p.id} onClick={() => setSel(p.id)} className={`cursor-pointer hover:bg-card-hover ${sel === p.id ? 'bg-card-hover' : ''}`}><td className="px-3 py-2">{p.displayName}<div className="text-xs text-muted">{p.steamId}</div></td><td className="px-3 py-2">{p.elo.FIVE_V_FIVE ?? '–'}</td><td className="px-3 py-2 text-xs">{p.roles.map((r) => r.key).join(', ') || '–'}</td></tr>)}
            </Table>
          )}
        </div>
        {d.data && (
          <Card className="space-y-4">
            <h2 className="text-lg font-bold">{d.data.displayName}</h2>
            <Input label="Grund (Pflicht, wird im Audit-Log gespeichert)" value={reason} onChange={(e) => setReason(e.target.value)} />
            {can('player.elo.edit') && <div className="flex items-end gap-2"><Input label="Neues Elo" type="number" min={0} max={5000} value={elo} onChange={(e) => setElo(e.target.value)} /><Button disabled={!elo || reason.length < 3 || act.busy} onClick={() => void act.run(() => api(`/admin/players/${d.data!.id}/elo`, { method: 'POST', body: { mode: 'FIVE_V_FIVE', elo: Number(elo), reason } }))}>Setzen</Button></div>}
            {can('player.ban') && <div className="flex items-end gap-2"><Input label="Ban-Dauer in Stunden (leer = permanent)" type="number" min={1} value={hours} onChange={(e) => setHours(e.target.value)} /><Button variant="danger" disabled={reason.length < 3 || act.busy} onClick={() => void act.run(() => api('/admin/bans', { method: 'POST', body: { userId: d.data!.id, reason, ...(hours ? { durationHours: Number(hours) } : {}) } }))}>Bannen</Button></div>}
            {can('player.unban') && <Button variant="secondary" disabled={reason.length < 3 || act.busy} onClick={() => void act.run(() => api(`/admin/players/${d.data!.id}/unban`, { method: 'POST', body: { reason } }))}>Ban aufheben</Button>}
            {act.error && <ErrorBox message={act.error} />}
            <h3 className="font-semibold">Bans</h3>
            <ul className="text-sm">{d.data.bans.length === 0 ? <li className="text-muted">Keine.</li> : d.data.bans.map((b) => <li key={b.id} className="py-1">{b.active ? '🔴' : '⚪'} {b.reason} <span className="text-xs text-muted">{fmtDate(b.createdAt)}{b.expiresAt ? ` bis ${fmtDate(b.expiresAt)}` : ''}</span></li>)}</ul>
          </Card>
        )}
      </div>
    </>
  );
}
