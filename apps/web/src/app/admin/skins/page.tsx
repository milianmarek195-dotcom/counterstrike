'use client';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle, Select, Table } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

interface Grant { userId: string; displayName?: string; level: number; expiresAt: string | null; source?: string }

/** Skin level management: only visible with the skin.assign permission (the server checks again). */
export default function AdminSkins() {
  const { can } = useAuth();
  const list = useApi<{ permissions: Grant[] }>('/admin/skins/permissions');
  const act = useAction(list.reload);
  const [steam, setSteam] = useState('');
  const [level, setLevel] = useState(1);
  const [duration, setDuration] = useState('1h');
  const grant = () => void act.run(async () => {
    const found = await api<{ players: Array<{ id: string }> }>(`/admin/players?q=${steam}`);
    const id = found.players[0]?.id;
    if (!id) throw new Error('Spieler nicht gefunden');
    await api('/admin/skins/permissions', { method: 'POST', body: { userId: id, level, duration } });
  });
  if (!can('skin.assign')) return <ErrorBox message="Dafür fehlt dir das Recht skin.assign." />;
  return (
    <>
      <PageTitle title="Skin-Rechte" subtitle="Level 1–3 nach Marktpreis. Temporäre Rechte laufen automatisch ab." />
      <Card className="mb-6 grid max-w-2xl gap-3 sm:grid-cols-4">
        <Input label="SteamID oder Name" value={steam} onChange={(e) => setSteam(e.target.value)} />
        <Select label="Level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>{[0, 1, 2, 3].map((l) => <option key={l} value={l}>Level {l}</option>)}</Select>
        <Select label="Dauer" value={duration} onChange={(e) => setDuration(e.target.value)}>{['15m', '1h', '2h', '1d', '7d', 'permanent'].map((d) => <option key={d}>{d}</option>)}</Select>
        <div className="flex items-end"><Button disabled={!steam || act.busy} onClick={grant}>Vergeben</Button></div>
      </Card>
      {act.error && <ErrorBox message={act.error} />}
      {list.loading && !list.data ? <Loading /> : (
        <Table head={['Spieler', 'Level', 'Läuft ab', '']}>
          {list.data?.permissions.map((g) => <tr key={g.userId}><td className="px-3 py-2">{g.displayName ?? g.userId}</td><td className="px-3 py-2">{g.level}</td><td className="px-3 py-2">{g.expiresAt ? fmtDate(g.expiresAt) : 'permanent'}</td><td className="px-3 py-2"><Button variant="ghost" onClick={() => void act.run(() => api(`/admin/skins/permissions/${g.userId}`, { method: 'DELETE' }))}>Entziehen</Button></td></tr>)}
        </Table>
      )}
    </>
  );
}
