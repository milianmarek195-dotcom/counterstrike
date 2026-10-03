import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn, STATUS_LABEL } from '@/lib/format';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border bg-card p-4', className)}>{children}</div>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b pb-4">
      <div className="border-l-4 border-primary pl-3">
        <h1>{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:brightness-110',
  secondary: 'border bg-card hover:bg-card-hover',
  danger: 'bg-danger text-white hover:brightness-110',
  ghost: 'hover:bg-card-hover',
};
const base = 'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 font-display text-[15px] font-bold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50';
export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={cn(base, variants[variant], className)} />;
}
export function LinkButton({ href, variant = 'primary', children, className }: { href: string; variant?: Variant; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn(base, variants[variant], className)}>
      {children}
    </Link>
  );
}

export function Input({ className, label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const field = <input {...p} className={cn('w-full rounded-md border bg-elevated px-3 py-2 text-sm placeholder:text-muted', className)} />;
  return label ? <label className="block text-sm"><span className="mb-1 block text-muted">{label}</span>{field}</label> : field;
}
export function Select({ className, label, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const field = <select {...p} className={cn('w-full rounded-md border bg-elevated px-3 py-2 text-sm', className)}>{children}</select>;
  return label ? <label className="block text-sm"><span className="mb-1 block text-muted">{label}</span>{field}</label> : field;
}

const tones: Record<string, string> = {
  LIVE: 'bg-danger/20 text-danger', FINISHED: 'bg-success/20 text-success', RUNNING: 'bg-danger/20 text-danger',
  SCHEDULED: 'bg-primary/20 text-primary', CANCELLED: 'bg-muted/20 text-muted', DRAFT: 'bg-muted/20 text-muted',
};
export function StatusBadge({ status }: { status: string }) {
  const live = status === 'LIVE' || status === 'RUNNING';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded px-2 py-0.5 font-display text-sm font-bold uppercase tracking-wider', tones[status] ?? 'bg-primary/15 text-primary')}>
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Rank tier shown as a level medal: a ring in the tier colour with the tier number inside. */
export function RankBadge({ rank, level }: { rank: { name: string; color: string } | null | undefined; level?: number }) {
  if (!rank) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {level !== undefined && (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 font-display text-xs font-extrabold" style={{ borderColor: rank.color, color: rank.color }}>{level}</span>
      )}
      <span className="rounded px-2 py-0.5 font-display text-sm font-bold uppercase tracking-wider" style={{ background: `${rank.color}2e`, color: rank.color }}>{rank.name}</span>
    </span>
  );
}

export function Loading() {
  return <p role="status" className="py-10 text-center text-sm text-muted">Lädt …</p>;
}
export function ErrorBox({ message }: { message: string }) {
  return <p role="alert" className="rounded-md border border-danger/50 bg-danger/10 p-3 text-sm text-danger">{message}</p>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted">{children}</p>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm">
        <thead className="bg-elevated font-display text-sm uppercase tracking-wider text-muted">
          <tr>{head.map((h) => <th key={h} scope="col" className="px-3 py-2.5 font-bold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="font-display text-sm uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-display text-3xl font-extrabold">{value}</div>
    </div>
  );
}
