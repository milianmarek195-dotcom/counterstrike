'use client';
import Link from 'next/link';
import { Card, ErrorBox, Loading, PageTitle, Stat, StatusBadge, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';

interface Dash {
  onlinePlayers: number; activeMatches: number; activeTournaments: number; upcomingTournaments: number;
  servers: { total: number; byStatus: Record<string, number>; list: Array<{ id: string; name: string; region: string; status: string; playerCount: number; maxPlayers: number; currentMatchId: string | null }> };
  recentMatches: Array<{ id: string; status: string; finishedAt: string | null }>;
  recentAdminActions: Array<{ id: string; actor: string; action: string; target: string | null; createdAt: string }>;
}

const sections = [
  { href: '/admin/players', label: 'Spieler & Bans', perm: 'player.view' },
  { href: '/admin/audit', label: 'Audit-Log', perm: 'audit.view' },
  { href: '/admin/skins', label: 'Skin-Rechte', perm: 'skin.assign' },
  { href: '/admin/settings', label: 'Einstellungen', perm: 'settings.manage' },
];

export default function Admin() {
  const { me, ready, can } = useAuth();
  const d = useApi<Dash>(can('admin.access') ? '/admin/dashboard' : null);
  useRealtime('servers', undefined, d.reload);
  if (!ready) return <Loading />;
  if (!can('admin.access')) return <ErrorBox message={me.user ? 'Dafür fehlen dir die Rechte.' : 'Bitte zuerst anmelden.'} />;
  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorBox message={d.error.message} />;
  if (!d.data) return <Loading />;
  const x = d.data!;
  return (
    <>
      <PageTitle title="Admin" subtitle="Übersicht über Plattform, Server und letzte Aktionen." />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Spieler online" value={x.onlinePlayers} /><Stat label="Aktive Matches" value={x.activeMatches} /><Stat label="Laufende Turniere" value={x.activeTournaments} /><Stat label="Server" value={`${x.servers.byStatus.READY ?? 0}/${x.servers.total} frei`} />
      </div>
      <div className="mb-6 flex flex-wrap gap-2">{sections.filter((s) => can(s.perm)).map((s) => <Link key={s.href} href={s.href} className="rounded-lg border bg-card px-3 py-2 text-sm font-medium hover:bg-card-hover">{s.label}</Link>)}</div>
      <h2 className="mb-2 text-lg font-bold">Server</h2>
      <Table head={['Name', 'Region', 'Status', 'Spieler', 'Match']}>
        {x.servers.list.map((s) => <tr key={s.id}><td className="px-3 py-2">{s.name}</td><td className="px-3 py-2">{s.region}</td><td className="px-3 py-2"><StatusBadge status={s.status} /></td><td className="px-3 py-2">{s.playerCount}/{s.maxPlayers}</td><td className="px-3 py-2">{s.currentMatchId ? <Link className="text-primary" href={`/matches/${s.currentMatchId}`}>öffnen</Link> : '–'}</td></tr>)}
      </Table>
      <h2 className="mb-2 mt-8 text-lg font-bold">Letzte Admin-Aktionen</h2>
      <Card><ul className="divide-y text-sm">{x.recentAdminActions.map((a) => <li key={a.id} className="flex justify-between gap-2 py-2"><span><b>{a.actor}</b> · {a.action} {a.target && <span className="text-muted">→ {a.target}</span>}</span><span className="text-xs text-muted">{fmtDate(a.createdAt)}</span></li>)}</ul></Card>
    </>
  );
}
