"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { DEFAULT_FORM, draftPolicy, type PolicyFormState } from "@/lib/policyForm";
import { BREACH_CONSECUTIVE, PAYOUT_FLOOR_BPS, PAYOUT_RAMP_SECONDS, SLA_TIERS } from "@/lib/pricing";
import { formatBps, formatDuration, formatGen } from "@/lib/units";
import { Button, Card, Field, Pill, Row } from "./ui";

const DURATIONS = [7, 30, 90, 180, 365];
const INTERVALS = [1, 5, 15, 60, 360];

export function PolicyMarketplace() {
  const { metrics, policies, account, balance, canTransact, createPolicy, tx } = useProtocol();
  const [form, setForm] = useState<PolicyFormState>(DEFAULT_FORM);
  const [minted, setMinted] = useState<number | null>(null);
  const set = <K extends keyof PolicyFormState>(k: K, v: PolicyFormState[K]) => { setForm((f) => ({ ...f, [k]: v })); setMinted(null); };

  const draft = useMemo(
    () => draftPolicy(form, { tvl: metrics?.tvl ?? 0n, lockedCoverage: metrics?.lockedCoverage ?? 0n, policies, holder: account, balance }),
    [form, metrics, policies, account, balance],
  );
  const tier = SLA_TIERS.find((t) => t.id === form.tier) ?? SLA_TIERS[0];
  const busy = tx.phase === "pending";

  const submit = async () => {
    if (!draft.valid || !draft.args || draft.premium === null) return;
    const id = await createPolicy(draft.args, draft.premium);
    if (id !== null) { setMinted(id); setForm(DEFAULT_FORM); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Policy marketplace</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Insure an RPC node, indexer, bridge relay or sequencer. Validators probe the endpoint independently; if it breaches your SLA the payout is released automatically.
        </p>
      </div>

      {minted !== null && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pulse/40 bg-pulse-dim px-5 py-4 text-sm text-pulse">
          <span className="font-semibold">Policy #{minted} minted. Cover activates after the activation delay.</span>
          <Link href={`/sentinel?policy=${minted}`} className="font-semibold underline">Watch it in the Sentinel →</Link>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-6 lg:grid-cols-5">
        <Card className="space-y-5 lg:col-span-3" title="Define your SLA">
          <div className="space-y-5">
            <Field id="endpoint" label="Endpoint URL" type="url" placeholder="https://rpc.your-node.io" autoComplete="off" spellCheck={false}
              value={form.url} onChange={(e) => set("url", e.target.value)} error={draft.errors.url}
              hint="Public http(s) endpoint. Private, loopback and credentialed URLs are rejected on-chain." />

            <fieldset>
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-400">Probe type</legend>
              <div className="flex gap-2">
                {([["rpc", "JSON-RPC", "eth_blockNumber: status, latency and block freshness"], ["http", "HTTP", "GET: status and latency only"]] as const).map(([v, label, hint]) => (
                  <label key={v} className={`flex-1 cursor-pointer rounded-lg border px-4 py-3 text-sm ${form.mode === v ? "border-capital bg-capital-dim" : "border-line hover:border-faint"}`}>
                    <input type="radio" name="mode" value={v} checked={form.mode === v} onChange={() => set("mode", v)} className="sr-only" />
                    <span className="block font-semibold">{label}</span>
                    <span className="mt-0.5 block text-xs text-muted">{hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-400">SLA tier</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {SLA_TIERS.map((t) => (
                  <label key={t.id} className={`cursor-pointer rounded-lg border px-4 py-3 ${form.tier === t.id ? "border-pulse bg-pulse-dim" : "border-line hover:border-faint"}`}>
                    <input type="radio" name="tier" value={t.id} checked={form.tier === t.id} onChange={() => set("tier", t.id)} className="sr-only" />
                    <span className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold">{t.label} <span className="num text-pulse">{t.uptimeLabel}</span></span>
                      <span className="num text-xs text-muted">{formatBps(t.rateBps, 1)}/yr</span>
                    </span>
                    <span className="mt-1 block text-xs text-muted">{t.blurb}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="latency" label="Max latency" inputMode="numeric" suffix="ms" value={form.maxLatencyMs} onChange={(e) => set("maxLatencyMs", e.target.value)} error={draft.errors.maxLatencyMs} />
              <div>
                <label htmlFor="interval" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400">Probe frequency</label>
                <select id="interval" value={form.intervalMinutes} onChange={(e) => set("intervalMinutes", e.target.value)} className="num w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-sm">
                  {INTERVALS.map((m) => <option key={m} value={m}>every {formatDuration(m * 60)} (minimum gap)</option>)}
                </select>
                {draft.errors.intervalMinutes && <p role="alert" className="mt-1.5 text-xs text-danger">{draft.errors.intervalMinutes}</p>}
              </div>
            </div>

            <Field id="coverage" label="Coverage amount" inputMode="decimal" suffix="GEN" placeholder="5.0" autoComplete="off" value={form.coverage} onChange={(e) => set("coverage", e.target.value)} error={draft.errors.coverage}
              hint={draft.limits ? `Pool can underwrite up to ${formatGen(draft.limits.max)} GEN for this endpoint right now.` : undefined} />

            <div>
              <Field id="days" label="Duration" inputMode="numeric" suffix="days" value={form.days} onChange={(e) => set("days", e.target.value)} error={draft.errors.days} />
              <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Duration presets">
                {DURATIONS.map((d) => (
                  <button key={d} type="button" aria-pressed={form.days === String(d)} onClick={() => set("days", String(d))}
                    className={`rounded-md border px-2.5 py-1 text-xs ${form.days === String(d) ? "border-capital text-capital" : "border-line text-muted hover:text-ink"}`}>{d}d</button>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card title="Quote" action={<Pill tone="pulse">{tier.label} · {tier.uptimeLabel}</Pill>} className="lg:sticky lg:top-24">
            <div aria-live="polite">
              <div className="text-xs uppercase tracking-wider text-zinc-400">Premium</div>
              <div className="num mt-1 text-3xl font-semibold" data-testid="premium">{draft.premium !== null ? `${formatGen(draft.premium, 6)} GEN` : "—"}</div>
              <div className="mt-1 text-xs text-muted">
                {draft.premiumBps !== null ? `${formatBps(draft.premiumBps)} of coverage for the term · ` : ""}{formatBps(draft.annualRateBps, 1)} per year
              </div>
            </div>
            <dl className="mt-4 border-t border-line pt-3">
              <Row label="Coverage">{form.coverage.trim() && draft.args ? `${formatGen(draft.args.coverage)} GEN` : "—"}</Row>
              <Row label="Cover starts">after {formatDuration(metrics?.activationDelay ?? 0)}</Row>
              <Row label="Term">{draft.args ? formatDuration(Number(form.days) * 86_400) : "—"}</Row>
              <Row label="Wallet balance">{balance !== null ? `${formatGen(balance)} GEN` : "—"}</Row>
              {balance !== null && draft.premium !== null && balance >= draft.premium && <Row label="After purchase">{formatGen(balance - draft.premium)} GEN</Row>}
            </dl>
            <ul className="mt-4 space-y-2 border-t border-line pt-3 text-xs text-muted">
              <li><span className="font-semibold text-ink">Breach rule · </span>{BREACH_CONSECUTIVE} consecutive failing probes (status ≠ 200, latency over limit, or frozen block) with uptime below {tier.uptimeLabel} stage a claim.</li>
              <li><span className="font-semibold text-ink">Grace period · </span>{formatDuration(metrics?.claimGrace ?? 0)}, then a second validator round re-verifies before paying.</li>
              <li><span className="font-semibold text-ink">Vesting · </span>payout starts at {formatBps(PAYOUT_FLOOR_BPS, 0)} of coverage and reaches 100% after {formatDuration(PAYOUT_RAMP_SECONDS)} — anti-collusion.</li>
              <li><span className="font-semibold text-ink">Baseline · </span>cover applies once the endpoint has been observed healthy.</li>
            </ul>
            <Button type="submit" className="mt-5 w-full" loading={busy} disabled={!draft.valid || !canTransact}>
              {!canTransact ? "Connect a wallet to mint" : draft.premium !== null ? `Mint policy · pay ${formatGen(draft.premium, 6)} GEN` : "Mint policy"}
            </Button>
          </Card>
        </div>
      </form>
    </div>
  );
}
