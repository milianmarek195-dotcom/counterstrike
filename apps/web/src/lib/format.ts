import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';

export const fmtNum = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? '–' : n.toLocaleString('de-DE', { maximumFractionDigits: digits }));

export const FORMAT_LABEL: Record<string, string> = { SINGLE_ELIMINATION: 'Single Elimination', DOUBLE_ELIMINATION: 'Double Elimination', ROUND_ROBIN: 'Round Robin', SWISS: 'Swiss' };
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Entwurf', SCHEDULED: 'Geplant', RUNNING: 'Läuft', PAUSED: 'Pausiert', FINISHED: 'Beendet', CANCELLED: 'Abgebrochen',
  WAITING: 'Wartet auf Server', LOBBY: 'Lobby', VETO: 'Map-Veto', MAP_FORCED: 'Map gesetzt', CONFIGURING: 'Wird konfiguriert', LIVE: 'LIVE', SERVER_ERROR: 'Serverfehler',
};
