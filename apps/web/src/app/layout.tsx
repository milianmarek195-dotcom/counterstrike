import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = { title: { default: 'Celtist – CS2 Turnierplattform', template: '%s · Celtist' }, description: 'CS2 Turniere, Matches, Rangliste und Skin-Loadouts.' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0e14' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de" data-theme="dark" suppressHydrationWarning>
      <body>
        <AuthProvider>
          <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-primary focus:p-2 focus:text-primary-fg">Zum Inhalt springen</a>
          <Nav />
          <main id="main" className="mx-auto max-w-6xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-6xl px-4 py-8 text-center text-xs text-muted">Celtist · nicht von Valve oder Steam unterstützt</footer>
        </AuthProvider>
      </body>
    </html>
  );
}
