'use client';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';

type Settings = Record<string, unknown>;

interface Reward { enabled: boolean; topN: number; level: number; days: number; tournamentsOnly: boolean }

function RewardCard({ value, onSave, busy }: { value: Reward; onSave: (v: Reward) => void; busy: boolean }) {
  const [v, setV] = useState<Reward>(value);
  const num = (k: 'topN' | 'level' | 'days') => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) });
  return (
    <Card className="mb-4">
      <h2 className="mb-1 font-semibold">Preis für die Top-Fragger des Siegerteams</h2>
      <p className="mb-3 text-sm text-muted">Nach jedem beendeten Match bekommen die besten Fragger (nach Kills) des Siegerteams automatisch Skin-Changer-Zugriff für einige Tage.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Input label="Top N Spieler" type="number" min={1} max={16} value={v.topN} onChange={num('topN')} />
        <Input label="Skin-Level" type="number" min={1} max={3} value={v.level} onChange={num('level')} />
        <Input label="Tage" type="number" min={1} value={v.days} onChange={num('days')} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Aktiv</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={v.tournamentsOnly} onChange={(e) => setV({ ...v, tournamentsOnly: e.target.checked })} /> Nur Turnier-Matches</label>
        <Button disabled={busy} onClick={() => onSave(v)}>Speichern</Button>
      </div>
    </Card>
  );
}

export default function AdminSettings() {
  const s = useApi<{ settings: Settings }>('/admin/settings');
  const act = useAction(s.reload);
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (s.loading && !s.data) return <Loading />;
  if (s.error) return <ErrorBox message={s.error.message} />;
  const entries = Object.entries(s.data!.settings);
  const save = (key: string) => void act.run(async () => {
    const raw = draft[key] ?? JSON.stringify(s.data!.settings[key]);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('Kein gültiges JSON (Zahlen, true/false oder "Text")'); }
    await api(`/admin/settings/${key}`, { method: 'PUT', body: { value } });
    setDraft((d) => { const n = { ...d }; delete n[key]; return n; });
  });
  return (
    <>
      <PageTitle title="Einstellungen" subtitle="Werte werden serverseitig validiert; jede Änderung landet im Audit-Log." />
      {act.error && <ErrorBox message={act.error} />}
      {s.data!.settings['match.topFraggerReward'] !== undefined && <RewardCard value={s.data!.settings['match.topFraggerReward'] as Reward} busy={act.busy} onSave={(v) => void act.run(() => api('/admin/settings/match.topFraggerReward', { method: 'PUT', body: { value: v } }))} />}
      <div className="grid gap-3 md:grid-cols-2">
        {entries.map(([key, value]) => (
          <Card key={key}>
            <div className="mb-1 font-mono text-xs text-muted">{key}</div>
            <div className="flex gap-2"><Input aria-label={key} value={draft[key] ?? JSON.stringify(value)} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /><Button variant="secondary" disabled={draft[key] === undefined || act.busy} onClick={() => save(key)}>Speichern</Button></div>
          </Card>
        ))}
      </div>
    </>
  );
}
