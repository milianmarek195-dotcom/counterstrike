'use client';
import { useState } from 'react';
import { ErrorBox, Input, Loading, PageTitle, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate } from '@/lib/format';

interface Entry { id: string; actorLabel: string; action: string; targetLabel: string | null; targetId: string | null; reason: string | null; oldValue: unknown; newValue: unknown; createdAt: string }

export default function AuditPage() {
  const [action, setAction] = useState('');
  const { data, loading, error } = useApi<{ entries: Entry[]; total: number }>(`/admin/audit?pageSize=50${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  return (
    <>
      <PageTitle title="Audit-Log" subtitle="Jede manuelle Admin- und Party-Leader-Aktion mit Akteur, Ziel, altem und neuem Wert." actions={<div className="w-56"><Input aria-label="Aktion" placeholder="z. B. match. oder player." value={action} onChange={(e) => setAction(e.target.value)} /></div>} />
      {error && <ErrorBox message={error.message} />}
      {loading && !data ? <Loading /> : (
        <Table head={['Zeit', 'Akteur', 'Aktion', 'Ziel', 'Änderung']}>
          {data?.entries.map((e) => (
            <tr key={e.id}><td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDate(e.createdAt)}</td><td className="px-3 py-2">{e.actorLabel}</td><td className="px-3 py-2 font-mono text-xs">{e.action}</td><td className="px-3 py-2">{e.targetLabel ?? e.targetId ?? '–'}</td>
              <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-muted" title={JSON.stringify({ von: e.oldValue, nach: e.newValue, grund: e.reason })}>{e.oldValue !== null || e.newValue !== null ? `${JSON.stringify(e.oldValue)} → ${JSON.stringify(e.newValue)}` : e.reason ?? ''}</td></tr>
          ))}
        </Table>
      )}
    </>
  );
}
