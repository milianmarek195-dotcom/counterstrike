'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, PageTitle } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const REASONS: Record<string, string> = {
  NONCE_INVALID: 'Steams Antwort wurde abgelehnt, weil die Uhr des Servers nicht mit der Steam-Zeit übereinstimmt. Bitte den Betreiber informieren.',
  NONCE_REPLAYED: 'Diese Anmeldung wurde schon verwendet. Bitte erneut anmelden.',
  STATE_MISSING: 'Die Anmeldung ist abgelaufen oder wurde bereits benutzt. Bitte erneut anmelden.',
  RETURN_TO_MISMATCH: 'Die Rückkehr-Adresse passt nicht. Bitte erneut von der Startseite anmelden.',
  VERIFICATION_FAILED: 'Steam konnte die Anmeldung nicht bestätigen. Bitte erneut versuchen.',
  STEAM_UNAVAILABLE: 'Steam ist gerade nicht erreichbar. Bitte später erneut versuchen.',
};

function Reason() {
  const reason = useSearchParams().get('reason') ?? '';
  const { login } = useAuth();
  return (
    <Card className="max-w-lg">
      <p className="mb-2 text-sm">{REASONS[reason] ?? 'Die Anmeldung mit Steam ist fehlgeschlagen.'}</p>
      {reason && <p className="mb-4 font-mono text-xs text-muted">Code: {reason.slice(0, 40)}</p>}
      <Button onClick={() => login('/')}>Erneut mit Steam anmelden</Button>
    </Card>
  );
}

export default function LoginFailed() {
  return (
    <>
      <PageTitle title="Anmeldung fehlgeschlagen" />
      <Suspense fallback={null}>
        <Reason />
      </Suspense>
    </>
  );
}
