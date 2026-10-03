import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/logo';
import { Nav } from '@/components/nav';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

const display = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-display', display: 'swap' });
const body = Inter({ subsets: ['latin'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = { title: { default: 'Celtist – CS2 Turnierplattform', template: '%s · Celtist' }, description: 'CS2 Turniere, Matches, Rangliste und Skin-Loadouts.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f1012' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" data-theme="dark" suppressHydrationWarning className={`${display.variable} ${body.variable}`}>
      <body>
        <AuthProvider>
          <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:p-2 focus:text-primary-fg">Zum Inhalt springen</a>
          <Nav />
          <main id="main" className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="mt-8 border-t">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-muted">
              <span className="flex items-center gap-2"><LogoMark size={20} />Celtist · CS2 Turniere &amp; Matches</span>
              <span>Nicht von Valve oder Steam unterstützt.</span>
            </div>
          </footer>
        </AuthProvider>
      </body>
    </html>
  );
}
