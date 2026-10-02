import Link from 'next/link';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn, STATUS_LABEL } from '@/lib/format';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border bg-card p-4', className)}>{children}</div>;
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:opacity-90',
  secondary: 'border bg-card hover:bg-card-hover',
  danger: 'bg-danger text-white hover:opacity-90',
  ghost: 'hover:bg-card-hover',
};
export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={cn('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)} />;
}
export function LinkButton({ href, variant = 'primary', children, className }: { href: string; variant?: Variant; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cn('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition', variants[variant], className)}>
      {children}
    </Link>
  );
}

export function Input({ className, label, ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const field = <input {...p} className={cn('w-full rounded-lg border bg-elevated px-3 py-2 text-sm placeholder:text-muted', className)} />;
  return label ? <label className="block text-sm"><span className="mb-1 block text-muted">{label}</span>{field}</label> : field;
}
export function Select({ className, label, children, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const field = <select {...p} className={cn('w-full rounded-lg border bg-elevated px-3 py-2 text-sm', className)}>{children}</select>;
  return label ? <label className="block text-sm"><span className="mb-1 block text-muted">{label}</span>{field}</label> : field;
}

const tones: Record<string, string> = {
  LIVE: 'bg-danger/20 text-danger', FINISHED: 'bg-success/20 text-success', RUNNING: 'bg-danger/20 text-danger',
  SCHEDULED: 'bg-accent/20 text-accent', CANCELLED: 'bg-muted/20 text-muted', DRAFT: 'bg-muted/20 text-muted',
};
export function StatusBadge({ status }: { status: string }) {
  return <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', tones[status] ?? 'bg-primary/20 text-primary')}>{STATUS_LABEL[status] ?? status}</span>;
}
export function RankBadge({ rank }: { rank: { name: string; color: string } | null | undefined }) {
  if (!rank) return null;
  return <span className="rounded-md px-2 py-0.5 text-xs font-bold" style={{ background: `${rank.color}33`, color: rank.color }}>{rank.name}</span>;
}

export function Loading() {
  return <p role="status" className="py-10 text-center text-sm text-muted">Lädt …</p>;
}
export function ErrorBox({ message }: { message: string }) {
  return <p role="alert" className="rounded-lg border border-danger/50 bg-danger/10 p-3 text-sm text-danger">{message}</p>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted">{children}</p>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <thead className="bg-elevated text-xs uppercase tracking-wide text-muted">
          <tr>{head.map((h) => <th key={h} scope="col" className="px-3 py-2.5 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}
