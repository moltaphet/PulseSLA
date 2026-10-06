"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { Tone } from "@/lib/types";

export type { Tone };

const TEXT: Record<Tone, string> = {
  pulse: "text-pulse", warn: "text-warn", danger: "text-danger", capital: "text-capital", muted: "text-muted",
};
const PILL: Record<Tone, string> = {
  pulse: "bg-pulse-dim text-emerald-300 border-emerald-400/30",
  warn: "bg-warn-dim text-amber-300 border-amber-400/30",
  danger: "bg-danger-dim text-rose-300 border-rose-400/30",
  capital: "bg-capital-dim text-indigo-200 border-indigo-300/30",
  muted: "bg-zinc-800/70 text-zinc-300 border-zinc-700/70",
};
const BAR: Record<Tone, string> = {
  pulse: "bg-pulse", warn: "bg-warn", danger: "bg-danger", capital: "bg-capital", muted: "bg-faint",
};

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-zinc-800/80 bg-zinc-900/70 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_8px_30px_rgb(0_0_0/0.25)] backdrop-blur-md transition-colors hover:border-zinc-700/60 ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800/80 px-5 py-3.5">
          <h2 className="text-sm font-semibold tracking-wide text-white">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = "muted", children, badge, large = false, className = "" }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; children?: ReactNode; badge?: ReactNode; large?: boolean; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/70 px-5 py-4 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)] backdrop-blur-md transition-colors hover:border-zinc-700/60 ${className}`} data-testid={`stat-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
      {tone !== "muted" && <span aria-hidden className={`pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full opacity-20 blur-2xl ${BAR[tone]}`} />}
      <div className="relative flex items-center justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">{label}</div>
        {badge}
      </div>
      <div className={`num relative mt-2 font-bold ${large ? "text-4xl sm:text-5xl" : "text-3xl"} ${tone === "muted" ? "text-white" : TEXT[tone]}`}>{value}</div>
      {hint && <div className="relative mt-1.5 text-sm text-zinc-400">{hint}</div>}
      {children}
    </div>
  );
}

export function Pill({ tone = "muted", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${PILL[tone]}`}>
      {children}
    </span>
  );
}

export function Dot({ tone, live = false }: { tone: Tone; live?: boolean }) {
  return <span aria-hidden className={`relative inline-block h-2 w-2 rounded-full ${BAR[tone]} ${TEXT[tone]} ${live ? "pulse-dot" : ""}`} />;
}

export function Button({
  variant = "primary", loading = false, className = "", children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "capital"; loading?: boolean }) {
  const styles = {
    primary: "bg-gradient-to-r from-emerald-500 to-cyan-400 text-zinc-950 shadow-lg shadow-emerald-500/20 hover:brightness-110 disabled:from-emerald-500/25 disabled:to-cyan-400/25 disabled:text-zinc-400 disabled:shadow-none",
    capital: "bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-lg shadow-violet-500/25 hover:brightness-110 disabled:from-violet-500/25 disabled:to-indigo-500/25 disabled:text-zinc-400 disabled:shadow-none",
    danger: "bg-gradient-to-r from-rose-500 to-red-500 text-white shadow-lg shadow-rose-500/25 hover:brightness-110 disabled:from-rose-500/25 disabled:to-red-500/25 disabled:text-zinc-400 disabled:shadow-none",
    ghost: "border border-zinc-700 bg-zinc-800/70 text-zinc-100 hover:border-zinc-500 disabled:text-zinc-500",
  }[variant];
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner() {
  return <span aria-hidden className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export function Field({
  label, id, error, hint, suffix, ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; error?: string | null; hint?: ReactNode; suffix?: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-zinc-300">{label}</label>
      <div className={`flex items-center rounded-xl border bg-zinc-950/70 px-3.5 ${error ? "border-rose-500/70" : "border-zinc-700 focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-500/20"}`}>
        <input id={id} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className="num w-full bg-transparent py-3 text-base text-white outline-none placeholder:text-zinc-500" {...input} />
        {suffix && <span className="ml-2 shrink-0 text-xs text-muted">{suffix}</span>}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-medium text-rose-300">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-zinc-400">{hint}</p>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-xl border border-zinc-700 bg-zinc-950/70 p-1">
      {options.map((o) => (
        <button key={o.value} role="tab" type="button" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${value === o.value ? "bg-gradient-to-r from-violet-500/80 to-indigo-500/80 text-white shadow" : "text-zinc-400 hover:text-white"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface MeterSegment { label: string; value: number; tone: Tone }

/** A stacked horizontal bar; segment values are proportions of `total`. */
export function Meter({ segments, total, label }: { segments: MeterSegment[]; total: number; label: string }) {
  return (
    <div>
      <div role="img" aria-label={label} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-zinc-950 p-0.5 ring-1 ring-zinc-800">
        {segments.map((s) => (
          <div key={s.label} className={`rounded-full ${BAR[s.tone]}`} style={{ width: `${total > 0 ? Math.min(100, (s.value / total) * 100) : 0}%` }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-zinc-200">
        {segments.map((s) => (
          <li key={s.label} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${BAR[s.tone]}`} />{s.label}</li>
        ))}
      </ul>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-white">{title}</p>
      {children && <p className="mt-1 text-sm text-zinc-400">{children}</p>}
    </div>
  );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <dt className="text-zinc-400">{label}</dt>
      <dd className="num text-right font-medium text-white">{children}</dd>
    </div>
  );
}
