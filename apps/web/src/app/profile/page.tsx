'use client';
import Link from 'next/link';
import { Button, Card, PageTitle } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function Profile() {
  const { me, login } = useAuth();
  if (!me.user) return <><PageTitle title="Profil" /><Button onClick={() => login('/profile')}>Mit Steam anmelden</Button></>;
  return (
    <>
      <PageTitle title={me.user.displayName} subtitle={`SteamID ${me.user.steamId}`} />
      <div className="grid gap-4 md:grid-cols-3">
        <Link href={`/players/${me.user.steamId}`}><Card className="hover:bg-card-hover"><h2 className="font-semibold">Öffentliches Profil</h2><p className="text-sm text-muted">Statistiken und Match-Historie</p></Card></Link>
        <Link href="/profile/loadouts"><Card className="hover:bg-card-hover"><h2 className="font-semibold">Skins &amp; Loadouts</h2><p className="text-sm text-muted">Inventar, Pattern, bis zu 3 Loadouts</p></Card></Link>
        <Link href="/teams"><Card className="hover:bg-card-hover"><h2 className="font-semibold">Teams</h2><p className="text-sm text-muted">Einladungen und Teamverwaltung</p></Card></Link>
      </div>
      {me.roles.length > 0 && <p className="mt-6 text-sm text-muted">Rollen: {me.roles.map((r) => r.name).join(', ')}</p>}
    </>
  );
}
