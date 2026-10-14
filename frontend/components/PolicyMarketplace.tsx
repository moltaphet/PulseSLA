"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { DEFAULT_FORM, draftPolicy, insurability, type PolicyFormState } from "@/lib/policyForm";
import {
  BREACH_CONSECUTIVE, MIN_OUTAGE_BLOCKS, MIN_OUTAGE_SECS, MIN_REFERENCES, PAYOUT_COOLDOWN_SECS, PAYOUT_FLOOR_BPS, PAYOUT_RAMP_SECONDS,
  PAYOUT_VEST_SECS, SLA_TIERS,
} from "@/lib/pricing";
import { formatBps, formatDuration, formatGen } from "@/lib/units";
import { Button, Card, Field, Pill, Row } from "./ui";

const DURATIONS = [7, 30, 90, 180, 365];
const INTERVALS = [1, 5, 15, 30];

export function PolicyMarketplace() {
  const { metrics, endpoints, policies, account, balance, canTransact, blockedReason, createPolicy, tx, now } = useProtocol();
  const [form, setForm] = useState<PolicyFormState>(DEFAULT_FORM);
  const [minted, setMinted] = useState<number | null>(null);
  const set = <K extends keyof PolicyFormState>(k: K, v: PolicyFormState[K]) => { setForm((f) => ({ ...f, [k]: v })); setMinted(null); };

  const draft = useMemo(
    () => draftPolicy(form, { tvl: metrics?.tvl ?? 0n, lockedCoverage: metrics?.lockedCoverage ?? 0n, policies, holder: account, balance, endpoints, now, claimGrace: metrics?.claimGrace }),
    [form, metrics, policies, account, balance, endpoints, now],
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
          Insure a public provider endpoint from the authenticated registry. Validators measure it against independent reference providers; a corroborated, continuous outage stages a claim and the payout then vests out to the holder.
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
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium uppercase tracking-wider text-zinc-400">Authenticated endpoint</legend>
              {endpoints.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line px-4 py-3 text-sm text-muted">
                  The registry is empty. The governor has not listed any endpoints yet, so there is nothing to insure.
                </p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Authenticated endpoint">
                  {endpoints.map((e) => {
                    const ins = insurability(e, endpoints, now);
                    const ok = ins.state === "insurable";
                    const picked = form.endpointId === e.id;
                    return (
                      <label key={e.id} aria-disabled={!ok}
                        className={`rounded-lg border px-4 py-3 ${ok ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${picked ? "border-pulse bg-pulse-dim" : "border-line hover:border-faint"}`}>
                        <input type="radio" name="endpoint" value={e.id} checked={picked} disabled={!ok} onChange={() => set("endpointId", e.id)} className="sr-only" />
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-semibold">{e.provider}</span>
                          <Pill tone={ok ? "pulse" : ins.state === "activating" ? "capital" : "muted"}>
                            {ok ? "Insurable" : ins.state === "activating" ? `in ${formatDuration(Math.max(0, ins.at - now))}` : ins.state === "delisted" ? "Delisted" : "No baseline"}
                          </Pill>
                        </span>
                        <span className="num mt-1 block truncate text-xs text-muted">{e.host}</span>
                        <span className="mt-0.5 block text-xs text-zinc-400">
                          {e.id} · chain {e.chainId}
                          {ins.state === "no-references" ? ` · only ${ins.have} reference providers` : ""}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {draft.errors.endpointId && <p role="alert" className="mt-1.5 text-xs text-danger">{draft.errors.endpointId}</p>}
              <p className="mt-1.5 text-xs text-zinc-400">
                Only endpoints the governor listed and the validators authenticated on-chain can be insured. A policy never takes a URL, so you cannot insure infrastructure you control.
              </p>
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

            <div>
              <label htmlFor="interval" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400">Probe frequency</label>
              <select id="interval" value={form.intervalMinutes} onChange={(e) => set("intervalMinutes", e.target.value)} className="num w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-sm">
                {INTERVALS.map((m) => <option key={m} value={m}>every {formatDuration(m * 60)} (minimum gap)</option>)}
              </select>
              {draft.errors.intervalMinutes && <p role="alert" className="mt-1.5 text-xs text-danger">{draft.errors.intervalMinutes}</p>}
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
              <li><span className="font-semibold text-ink">Corroboration · </span>every round also probes ≥ {MIN_REFERENCES} independent providers on the same chain. A failure only counts while most of them are healthy, so an observer-side or network-wide outage is never attributed to the provider.</li>
              <li><span className="font-semibold text-ink">Breach rule · </span>{BREACH_CONSECUTIVE} consecutive corroborated failures spanning ≥ {formatDuration(MIN_OUTAGE_SECS)} and ≥ {MIN_OUTAGE_BLOCKS} chain blocks, with uptime below {tier.uptimeLabel}, stage a claim. Rate limiting (HTTP 429) is inconclusive.</li>
              <li><span className="font-semibold text-ink">Grace period · </span>{formatDuration(metrics?.claimGrace ?? 0)}, then a fresh corroborated round re-verifies before the breach is confirmed.</li>
              <li><span className="font-semibold text-ink">Vesting · </span>the payout starts at {formatBps(PAYOUT_FLOOR_BPS, 0)} of coverage and reaches 100% after {formatDuration(PAYOUT_RAMP_SECONDS)} of policy age, then is released after a {formatDuration(PAYOUT_COOLDOWN_SECS)} cooldown, streaming over {formatDuration(PAYOUT_VEST_SECS)}.</li>
              <li><span className="font-semibold text-ink">Baseline · </span>cover applies once the endpoint has been observed healthy.</li>
            </ul>
            <Button type="submit" className="mt-5 w-full" loading={busy} disabled={!draft.valid || !canTransact}>
              {!canTransact ? (blockedReason ?? "Connect a wallet to mint") : draft.premium !== null ? `Mint policy · pay ${formatGen(draft.premium, 6)} GEN` : "Mint policy"}
            </Button>
          </Card>
        </div>
      </form>
    </div>
  );
}
