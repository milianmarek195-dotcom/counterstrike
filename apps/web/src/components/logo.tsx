import { cn } from '@/lib/format';

/**
 * Celtist logo: a hexagon (the badge) around an open "C" with a centre dot, like a scope. Drawn for this project;
 * it does not reuse anyone else's mark.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Celtist" className={className}>
      <defs>
        <linearGradient id="celtist-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ff5500" />
        </linearGradient>
      </defs>
      <path d="M32 6 54 19v26L32 58 10 45V19z" fill="none" stroke="url(#celtist-g)" strokeWidth="5" strokeLinejoin="round" />
      <path d="M43 25a12.5 12.5 0 1 0 0 14" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="2.8" fill="url(#celtist-g)" />
    </svg>
  );
}

export function Logo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-fg', className)}>
      <LogoMark size={compact ? 28 : 34} />
      {!compact && (
        <span className="font-display text-2xl font-extrabold leading-none tracking-wider">
          CELT<span className="text-primary">IST</span>
        </span>
      )}
    </span>
  );
}
