'use client';
import { useState } from 'react';
import { Button, Card, ErrorBox, Input, Loading, PageTitle } from '@/components/ui';
import { api, useAction, useApi } from '@/lib/api';

type Settings = Record<string, unknown>;

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
