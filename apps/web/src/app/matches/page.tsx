'use client';
import Link from 'next/link';
import { Empty, ErrorBox, Loading, PageTitle, StatusBadge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface M { id: string; kind: string; status: string; bestOf: number; finishedAt: string | null; startedAt: string | null; teams: { A: { name: string; score: number }; B: { name: string; score: number } }; map: { name: string; scoreA: number; scoreB: number } | null; tournament: { name: string } | null }

export default function Matches() {
  const { data, loading, error, reload } = useApi<{ matches: M[] }>('/matches?pageSize=50');
  useRealtime('live', undefined, reload);
  return (
    <>
      <PageTitle title="Matches" subtitle="Live-Matches aktualisieren sich automatisch." />
      {error && <ErrorBox message={error.message} />}
      {loading ? <Loading /> : !data?.matches.length ? <Empty>Keine Matches.</Empty> : (
        <div className="space-y-2">
          {data.matches.map((m) => (
            <Link key={m.id} href={`/matches/${m.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3 hover:bg-card-hover">
              <div>
                <div className="font-medium">{m.teams.A.name} <b className="text-primary">{m.teams.A.score} : {m.teams.B.score}</b> {m.teams.B.name}</div>
                <div className="text-xs text-muted">{m.tournament?.name ?? (m.kind === 'CUSTOM' ? 'Party-Match' : m.kind)} · BO{m.bestOf} · {fmtDate(m.finishedAt ?? m.startedAt)}</div>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted">{m.map && <span>{m.map.name} {m.map.scoreA}:{m.map.scoreB}</span>}<StatusBadge status={m.status} /></div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
