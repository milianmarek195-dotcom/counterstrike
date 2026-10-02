'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Card, Empty, ErrorBox, Loading, PageTitle, Select, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate, FORMAT_LABEL } from '@/lib/format';

interface Tournament { id: string; name: string; status: string; format: string; teamSize: number; maxTeams: number; teamCount: number; startsAt: string; registrationOpen: boolean; bestOf: number }

export default function Tournaments() {
  const [status, setStatus] = useState('');
  const { data, loading, error } = useApi<{ tournaments: Tournament[] }>(`/tournaments?pageSize=50${status ? `&status=${status}` : ''}`);
  return (
    <>
      <PageTitle title="Turniere" subtitle="Single und Double Elimination mit Map-Veto." actions={<div className="w-44"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Alle</option><option value="SCHEDULED">Geplant</option><option value="RUNNING">Läuft</option><option value="FINISHED">Beendet</option></Select></div>} />
      {error && <ErrorBox message={error.message} />}
      {loading ? <Loading /> : !data?.tournaments.length ? <Empty>Keine Turniere gefunden.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.tournaments.map((t) => (
            <Link key={t.id} href={`/tournaments/${t.id}`}>
              <Card className="transition hover:bg-card-hover">
                <div className="flex items-start justify-between gap-2"><h2 className="font-semibold">{t.name}</h2><StatusBadge status={t.status} /></div>
                <p className="mt-1 text-sm text-muted">{FORMAT_LABEL[t.format]} · {t.teamSize}v{t.teamSize} · BO{t.bestOf} · {t.teamCount}/{t.maxTeams} Teams</p>
                <p className="mt-1 text-xs text-muted">{fmtDate(t.startsAt)}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
