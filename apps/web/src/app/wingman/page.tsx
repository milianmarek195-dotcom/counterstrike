import type { Metadata } from 'next';
import { Card, PageTitle } from '@/components/ui';

export const metadata: Metadata = { title: 'Wingman Cups' };

/** Wingman is intentionally not implemented yet: this page is the whole feature until it is announced. */
export default function Wingman() {
  return (
    <>
      <PageTitle title="Wingman Cups" />
      <Card className="py-16 text-center">
        <span className="rounded-full bg-primary/20 px-3 py-1 text-xs font-bold uppercase tracking-widest text-primary">Coming Soon</span>
        <h2 className="mt-4 text-2xl font-bold">Wingman Cups kommen bald</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">2v2-Turniere sind in Planung. Bis dahin kannst du in den 5v5-Turnieren spielen oder mit deiner Party ein eigenes Match mit beliebiger Teamgröße starten.</p>
      </Card>
    </>
  );
}
