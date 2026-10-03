'use client';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle, Select, Table } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';

interface Grant { id: string; user: { id: string; steamId: string; displayName: string }; level: number; floatEditing: boolean; stickerCrafts: boolean; expiresAt: string | null; grantedBy: string; reason: string | null }
interface Overview { maxGrantableLevel: number; grants: Grant[] }

/** Skin level management: only visible with the skin.assign permission (the server checks again). */
export default function AdminSkins() {
  const { can } = useAuth();
  const list = useApi<Overview>('/admin/skins/permissions');
  const act = useAction(list.reload);
  const [who, setWho] = useState('');
  const [level, setLevel] = useState(3);
  const [duration, setDuration] = useState('7d');
  const [days, setDays] = useState(7);
  const [floatEditing, setFloatEditing] = useState(true);
  const grant = () => void act.run(async () => {
    const found = await api<{ players: Array<{ id: string; steamId: string; displayName: string }> }>(`/admin/players?q=${encodeURIComponent(who.trim())}&pageSize=5`);
    const exact = found.players.find((p) => p.steamId === who.trim() || p.displayName.toLowerCase() === who.trim().toLowerCase()) ?? found.players[0];
    if (!exact) throw new Error('Spieler nicht gefunden');
    const custom = duration === 'custom';
    await api('/admin/skins/permissions', { method: 'POST', body: { userId: exact.id, level, floatEditing, duration, ...(custom ? { customMinutes: days * 1440 } : {}) } });
    setWho('');
  });
  if (!can('skin.assign')) return <ErrorBox message="Dafür fehlt dir das Recht skin.assign." />;
  const max = list.data?.maxGrantableLevel ?? 3;
  return (
    <>
      <PageTitle title="Skin-Rechte" subtitle="Level 1–3 nach Marktpreis. Temporäre Rechte laufen automatisch ab." />
      <Card className="mb-6 grid max-w-3xl gap-3 sm:grid-cols-5">
        <Input label="SteamID oder Name" value={who} onChange={(e) => setWho(e.target.value)} />
        <Select label="Level" value={level} onChange={(e) => setLevel(Number(e.target.value))}>{[0, 1, 2, 3].filter((l) => l <= max).map((l) => <option key={l} value={l}>Level {l}</option>)}</Select>
        <Select label="Dauer" value={duration} onChange={(e) => setDuration(e.target.value)}>{['15m', '1h', '2h', '1d', '7d', 'permanent', 'custom'].map((d) => <option key={d} value={d}>{d === 'custom' ? 'Tage …' : d}</option>)}</Select>
        {duration === 'custom' ? <Input label="Tage" type="number" min={1} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /> : <div />}
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" checked={floatEditing} onChange={(e) => setFloatEditing(e.target.checked)} /> Float</label>
          <Button disabled={!who || act.busy} onClick={grant}>Vergeben</Button>
        </div>
      </Card>
      {act.error && <ErrorBox message={act.error} />}
      {list.error && <ErrorBox message={list.error.message} />}
      {list.loading && !list.data ? <Loading /> : (
        <Table head={['Spieler', 'Level', 'Läuft ab', 'Von', '']}>
          {(list.data?.grants ?? []).map((g) => (
            <tr key={g.id}>
              <td className="px-3 py-2">{g.user.displayName}<div className="text-xs text-muted">{g.user.steamId}</div></td>
              <td className="px-3 py-2">{g.level}</td>
              <td className="px-3 py-2">{g.expiresAt ? fmtDate(g.expiresAt) : 'permanent'}</td>
              <td className="px-3 py-2 text-xs text-muted">{g.grantedBy}{g.reason ? ` · ${g.reason}` : ''}</td>
              <td className="px-3 py-2"><Button variant="ghost" onClick={() => void act.run(() => api(`/admin/skins/permissions/${g.user.id}`, { method: 'DELETE' }))}>Entziehen</Button></td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
