'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';
import { Button } from './ui';

const links = [
  { href: '/tournaments', label: 'Turniere' },
  { href: '/matches', label: 'Matches' },
  { href: '/ranking', label: 'Rangliste' },
  { href: '/teams', label: 'Teams' },
  { href: '/party', label: 'Party' },
  { href: '/wingman', label: 'Wingman Cups' },
];

export function Nav() {
  const { me, ready, can, login, logout } = useAuth();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [light, setLight] = useState(false);
  useEffect(() => {
    try {
      const t = localStorage.getItem('theme');
      if (t === 'light') { document.documentElement.dataset.theme = 'light'; setLight(true); }
    } catch { /* storage may be blocked */ }
  }, []);
  useEffect(() => setOpen(false), [path]);
  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.dataset.theme = next ? 'light' : 'dark';
    try { localStorage.setItem('theme', next ? 'light' : 'dark'); } catch { /* ignore */ }
  };
  return (
    <header className="sticky top-0 z-40 border-b bg-elevated/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="text-lg font-extrabold tracking-tight text-primary">CELTIST</Link>
        <nav aria-label="Hauptnavigation" className={cn('absolute left-0 top-14 w-full flex-col gap-1 border-b bg-elevated p-3 md:static md:flex md:w-auto md:flex-row md:border-0 md:bg-transparent md:p-0', open ? 'flex' : 'hidden md:flex')}>
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={cn('rounded-lg px-3 py-2 text-sm font-medium hover:bg-card-hover', path.startsWith(l.href) && 'text-primary')}>{l.label}</Link>
          ))}
          {can('admin.access') && <Link href="/admin" className="rounded-lg px-3 py-2 text-sm font-medium text-accent hover:bg-card-hover">Admin</Link>}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={toggle} aria-label="Farbschema wechseln" className="rounded-lg p-2 hover:bg-card-hover">{light ? <Moon size={18} /> : <Sun size={18} />}</button>
          {ready && (me.user ? (
            <>
              <Link href="/profile" className="hidden text-sm font-medium hover:text-primary sm:block">{me.user.displayName}</Link>
              <Button variant="secondary" onClick={() => void logout()}>Abmelden</Button>
            </>
          ) : (
            <Button onClick={() => login(path)}>Mit Steam anmelden</Button>
          ))}
          <button className="rounded-lg p-2 hover:bg-card-hover md:hidden" aria-label="Menü" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </div>
    </header>
  );
}
