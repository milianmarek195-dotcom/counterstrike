'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/format';
import { Logo } from './logo';
import { Button } from './ui';

const links = [
  { href: '/tournaments', label: 'Turniere' },
  { href: '/matches', label: 'Matches' },
  { href: '/ranking', label: 'Rangliste' },
  { href: '/teams', label: 'Teams' },
  { href: '/party', label: 'Party' },
  { href: '/profile/loadouts', label: 'Skin-Changer' },
  { href: '/wingman', label: 'Wingman' },
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
  const active = (href: string) => (href === '/' ? path === '/' : path === href || (href !== '/profile/loadouts' && path.startsWith(`${href}/`)));
  return (
    <header className="sticky top-0 z-40 border-b bg-elevated/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-3 sm:gap-5 sm:px-4">
        <Link href="/" aria-label="Celtist Startseite"><Logo /></Link>
        <nav aria-label="Hauptnavigation" className={cn('absolute left-0 top-16 w-full flex-col border-b bg-elevated p-2 lg:static lg:flex lg:h-16 lg:w-auto lg:flex-row lg:items-stretch lg:border-0 lg:bg-transparent lg:p-0', open ? 'flex' : 'hidden lg:flex')}>
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={cn('relative flex items-center px-3 font-display text-[15px] font-bold whitespace-nowrap uppercase tracking-wider text-muted transition-colors hover:text-fg max-lg:py-3', active(l.href) && 'text-fg after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:bg-primary max-lg:after:hidden max-lg:text-primary')}>{l.label}</Link>
          ))}
          {can('admin.access') && <Link href="/admin" className={cn('flex items-center px-3 font-display text-[15px] font-bold uppercase tracking-wider text-primary hover:opacity-80 max-lg:py-3', path.startsWith('/admin') && 'underline')}>Admin</Link>}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={toggle} aria-label="Farbschema wechseln" className="rounded-md p-2 text-muted hover:bg-card-hover hover:text-fg">{light ? <Moon size={18} /> : <Sun size={18} />}</button>
          {ready && (me.user ? (
            <>
              <Link href="/profile" className="hidden items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold hover:bg-card-hover sm:flex">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{me.user.displayName.slice(0, 1).toUpperCase()}</span>
                {me.user.displayName}
              </Link>
              <Button variant="secondary" className="whitespace-nowrap px-3 sm:px-4" onClick={() => void logout()}>Abmelden</Button>
            </>
          ) : (
            <Button className="whitespace-nowrap px-3 sm:px-4" onClick={() => login(path)}><span className="sm:hidden">Login</span><span className="hidden sm:inline">Mit Steam anmelden</span></Button>
          ))}
          <button className="rounded-md p-2 hover:bg-card-hover lg:hidden" aria-label="Menü" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </div>
    </header>
  );
}
