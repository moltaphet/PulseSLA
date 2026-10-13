"use client";

import { useMemo, useState } from "react";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { probeChecks } from "@/lib/policyState";
import type { Incident, IncidentKind, Tone } from "@/lib/types";
import { formatGen, formatTime, shortAddress } from "@/lib/units";
import { ConsensusBreakdown } from "./ConsensusBreakdown";
import { Card, EmptyState, Pill, Stat } from "./ui";

const KIND: Record<IncidentKind, { label: string; tone: Tone }> = {
  POLICY_CREATED: { label: "Policy minted", tone: "capital" },
  PROBE: { label: "Probe", tone: "muted" },
  BREACH_STAGED: { label: "Claim staged", tone: "warn" },
  BREACH_CONFIRMED_VESTING: { label: "Breach confirmed", tone: "danger" },
  CLAIM_DISMISSED: { label: "Claim dismissed", tone: "warn" },
  PAYOUT_RELEASED: { label: "Payout released", tone: "danger" },
  POLICY_EXPIRED: { label: "Expired", tone: "muted" },
  CLAIM_LAPSED: { label: "Claim lapsed", tone: "muted" },
  ENDPOINT_LISTED: { label: "Endpoint listed", tone: "capital" },
  ENDPOINT_DELISTED: { label: "Endpoint delisted", tone: "muted" },
  GOVERNOR_CHANGED: { label: "Governor changed", tone: "warn" },
};

type Filter = "all" | "breaches" | "failing" | "inconclusive" | "payouts" | "registry";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "breaches", label: "Breaches & claims" },
  { value: "failing", label: "Failing rounds" },
  { value: "inconclusive", label: "Inconclusive rounds" },
  { value: "payouts", label: "Payouts" },
  { value: "registry", label: "Registry" },
];

function matches(i: Incident, f: Filter): boolean {
  switch (f) {
    case "breaches": return ["BREACH_STAGED", "BREACH_CONFIRMED_VESTING", "CLAIM_DISMISSED", "PAYOUT_RELEASED", "CLAIM_LAPSED"].includes(i.kind);
    case "failing": return i.kind === "PROBE" && i.verdict === "FAILING";
    case "inconclusive": return i.kind === "PROBE" && i.verdict === "INCONCLUSIVE";
    case "payouts": return i.kind === "BREACH_CONFIRMED_VESTING" || i.kind === "PAYOUT_RELEASED";
    case "registry": return i.kind === "ENDPOINT_LISTED" || i.kind === "ENDPOINT_DELISTED" || i.kind === "GOVERNOR_CHANGED";
    default: return true;
  }
}

function IncidentRow({ inc, open, onToggle, votes }: { inc: Incident; open: boolean; onToggle: () => void; votes?: Incident["votes"] }) {
  const k = KIND[inc.kind];
  const checks = probeChecks(inc);
  const tone: Tone = inc.kind === "PROBE" ? (inc.verdict === "INCONCLUSIVE" ? "muted" : inc.ok ? "pulse" : "danger") : k.tone;
  return (
    <li className="border-b border-line last:border-0">
      <button type="button" onClick={onToggle} aria-expanded={open} className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-1 py-3 text-left hover:bg-panel-2/50 sm:grid-cols-[11rem_9rem_5rem_1fr_auto]">
        <span className="num hidden text-xs text-muted sm:block">{formatTime(inc.time)}</span>
        <span><Pill tone={tone}>{inc.kind === "PROBE" ? (inc.verdict === "INCONCLUSIVE" ? "Probe · inconclusive" : inc.ok ? "Probe · healthy" : "Probe · failing") : k.label}</Pill></span>
        <span className="num hidden text-xs text-muted sm:block">{inc.policyId > 0 ? `#${inc.policyId}` : "registry"}</span>
        <span className="min-w-0 truncate text-sm text-ink/90">{inc.detail}</span>
        <span aria-hidden className="text-zinc-400">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="grid gap-6 px-1 pb-5 pt-1 lg:grid-cols-2" data-testid="incident-detail">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Reasoning</h3>
            <p className="text-sm">{inc.detail}</p>
            {checks.length > 0 && (
              <table className="w-full text-sm">
                <caption className="sr-only">Corroborated SLA predicates evaluated for this observation</caption>
                <thead><tr className="text-left text-xs text-zinc-400"><th className="py-1 font-medium">Check</th><th className="font-medium">Required</th><th className="font-medium">Observed</th><th className="sr-only">Result</th></tr></thead>
                <tbody>
                  {checks.map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="py-1.5 text-muted">{c.label}</td>
                      <td className="num text-xs text-muted">{c.expected}</td>
                      <td className="num text-xs">{c.observed}</td>
                      <td className={`text-right text-xs font-semibold ${c.pass === null ? "text-zinc-400" : c.pass ? "text-pulse" : "text-danger"}`}>{c.pass === null ? "n/a" : c.pass ? "pass" : "fail"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-zinc-400">Triggered by {inc.by ? shortAddress(inc.by) : "the protocol"} · event #{inc.index}</p>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Validator consensus</h3>
            {inc.ok === undefined ? <p className="text-sm text-muted">This event is a state transition, not a web observation.</p> : <ConsensusBreakdown votes={votes} />}
          </div>
        </div>
      )}
    </li>
  );
}

export function IncidentInspector() {
  const { incidents, policies, votesByIncident, loading } = useProtocol();
  const [filter, setFilter] = useState<Filter>("breaches");
  const [policyId, setPolicyId] = useState<number | "all">("all");
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const rows = useMemo(
    () => incidents.filter((i) => matches(i, filter) && (policyId === "all" || i.policyId === policyId)).slice().reverse(),
    [incidents, filter, policyId],
  );
  const confirmed = policies.filter((p) => p.status === "VESTING" || p.status === "PAID");
  const totalReleased = confirmed.reduce((s, p) => s + p.released, 0n);
  const payoutEvents = new Map(incidents.filter((i) => i.kind === "BREACH_CONFIRMED_VESTING").map((i) => [i.policyId, i]));

  if (loading && incidents.length === 0) return <p className="text-sm text-muted" role="status">Loading incident log…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Claim &amp; incident inspector</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">The complete, append-only record: every corroborated round the validators ran, every breach they confirmed, and every vested payout released.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Breaches confirmed" value={incidents.filter((i) => i.kind === "BREACH_CONFIRMED_VESTING").length} tone="danger" hint={`${formatGen(totalReleased)} GEN released so far`} />
        <Stat label="Claims dismissed" value={incidents.filter((i) => i.kind === "CLAIM_DISMISSED").length} tone="warn" hint="endpoint recovered in grace" />
        <Stat label="Failing rounds" value={incidents.filter((i) => i.kind === "PROBE" && i.verdict === "FAILING").length} hint="corroborated by the references" />
        <Stat label="Inconclusive rounds" value={incidents.filter((i) => i.kind === "PROBE" && i.verdict === "INCONCLUSIVE").length} hint="no baseline or rate limited: not counted" />
      </div>

      <Card title="Parametric payouts">
        {confirmed.length === 0 ? (
          <p className="text-sm text-muted">No breach has been confirmed yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {confirmed.map((p) => {
              const ev = payoutEvents.get(p.id);
              return (
                <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="num font-semibold">{p.host}</span>
                    <span className="ml-2 text-xs text-muted">policy #{p.id} → {shortAddress(p.holder)}</span>
                    {ev && <p className="mt-0.5 truncate text-xs text-muted">{ev.detail}</p>}
                  </div>
                  <div className="text-right">
                    <div className="num font-semibold text-danger">−{formatGen(p.payout)} GEN</div>
                    <div className="text-xs text-muted">
                      {formatGen(p.released)} released{p.status === "VESTING" ? ` · ${formatGen(p.releasable)} releasable now` : " · fully paid"}
                      {" · "}of {formatGen(p.coverage)} GEN coverage{ev ? ` · ${formatTime(ev.time)}` : ""}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Event log" action={
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Filter by policy" value={String(policyId)} onChange={(e) => setPolicyId(e.target.value === "all" ? "all" : Number(e.target.value))} className="rounded-md border border-line bg-bg px-2 py-1 text-xs">
            <option value="all">All policies</option>
            {policies.map((p) => <option key={p.id} value={p.id}>#{p.id} {p.host}</option>)}
          </select>
        </div>
      }>
        <div role="group" aria-label="Event filter" className="mb-3 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.value} type="button" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === f.value ? "border-capital bg-capital-dim text-capital" : "border-line text-muted hover:text-ink"}`}>{f.label}</button>
          ))}
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No events match this filter" />
        ) : (
          <ul aria-label="Incident events">
            {rows.map((inc) => (
              <IncidentRow key={inc.index} inc={inc} open={openIdx === inc.index}
                onToggle={() => setOpenIdx(openIdx === inc.index ? null : inc.index)} votes={inc.votes ?? votesByIncident[inc.index]} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
