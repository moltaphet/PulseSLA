"use client";

import { useMemo, useState } from "react";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { SETTLE_WINDOW_SECONDS } from "@/lib/pricing";
import { policyHealth, probeEligibility, probeSeries, settleEligibility } from "@/lib/policyState";
import type { Policy } from "@/lib/types";
import { formatBps, formatDuration, formatGen, formatTime, shortAddress, timeAgo } from "@/lib/units";
import { ConsensusBreakdown } from "./ConsensusBreakdown";
import { LatencyChart } from "./LatencyChart";
import { UptimeBadge } from "./UptimeBadge";
import { Button, Card, Dot, EmptyState, Pill, Row } from "./ui";

const PRIORITY: Record<string, number> = { BREACH_PENDING: 0, ACTIVE: 1, PAID: 2, LAPSED: 3, EXPIRED: 4 };

export function Sentinel({ initialPolicyId }: { initialPolicyId?: number }) {
  const { policies, incidents, now, account, metrics, loading, canTransact, tx, triggerProbe, settleClaim, expirePolicy, votesByIncident } = useProtocol();
  const [onlyMine, setOnlyMine] = useState(false);
  const [picked, setPicked] = useState<number | null>(initialPolicyId ?? null);

  const visible = useMemo(() => {
    const mine = account?.toLowerCase();
    return policies
      .filter((p) => !onlyMine || p.holder === mine)
      .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || b.id - a.id);
  }, [policies, onlyMine, account]);

  // Pin the default selection once data arrives, so settling a claim does not make the view jump to another policy.
  if (picked === null && visible.length > 0) setPicked(visible[0].id);
  const selected: Policy | undefined = policies.find((p) => p.id === picked) ?? visible[0];
  const series = useMemo(() => (selected ? probeSeries(incidents, selected.id) : []), [incidents, selected]);
  const lastObs = useMemo(() => {
    const own = selected ? incidents.filter((i) => i.policyId === selected.id && i.ok !== undefined) : [];
    return own[own.length - 1];
  }, [incidents, selected]);

  if (loading && policies.length === 0) return <p className="text-sm text-muted" role="status">Loading insured endpoints…</p>;
  const busy = tx.phase === "pending";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Live infrastructure sentinel</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">Every insured endpoint, its measured uptime and the validator verdict behind it. Anyone can trigger a probe by posting a small refundable bond.</p>
      </div>

      {policies.length === 0 ? (
        <EmptyState title="No insured endpoints yet">Mint a policy in the marketplace to start monitoring an endpoint.</EmptyState>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <aside aria-label="Insured endpoints" className="space-y-3 lg:col-span-1">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} /> Only my policies
            </label>
            {visible.length === 0 && <p className="text-sm text-muted">You hold no policies.</p>}
            <ul className="space-y-2">
              {visible.map((p) => {
                const h = policyHealth(p, now);
                const active = selected?.id === p.id;
                return (
                  <li key={p.id}>
                    <button type="button" aria-pressed={active} onClick={() => setPicked(p.id)}
                      className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${active ? "border-capital bg-capital-dim/40" : "border-line bg-panel hover:border-faint"}`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="num truncate text-sm font-semibold">{p.host}</span>
                        <Pill tone={h.tone}><Dot tone={h.tone} live={h.live} />{h.label}</Pill>
                      </span>
                      <span className="mt-1 flex justify-between text-xs text-muted">
                        <span>#{p.id} · {formatGen(p.coverage, 2)} GEN</span>
                        <span className="num">{p.samplesTotal ? formatBps(p.uptimeBps) : "no samples"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {selected && (
            <div className="space-y-6 lg:col-span-2" data-testid="sentinel-detail">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="num truncate text-xl font-semibold">{selected.host}</h2>
                      {(() => { const h = policyHealth(selected, now); return <Pill tone={h.tone}><Dot tone={h.tone} live={h.live} />{h.label}</Pill>; })()}
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Policy #{selected.id} · held by {shortAddress(selected.holder)} · {selected.probeMode === "rpc" ? "JSON-RPC" : "HTTP"} probe · ≤ {selected.maxLatencyMs} ms · every {formatDuration(selected.probeInterval)}
                    </p>
                  </div>
                  <UptimeBadge uptimeBps={selected.uptimeBps} slaBps={selected.minUptimeBps} samples={selected.samplesTotal} />
                </div>
                <dl className="mt-4 grid gap-x-8 border-t border-line pt-3 sm:grid-cols-2">
                  <Row label="Last probed block">{selected.lastBlock > 0 ? selected.lastBlock.toLocaleString("en-US") : "—"}</Row>
                  <Row label="Last probe">{timeAgo(selected.lastProbeAt, now)}</Row>
                  <Row label="Last latency">{selected.lastProbeAt ? `${selected.lastLatencyMs} ms` : "—"}</Row>
                  <Row label="Failure streak">{selected.consecutiveFailures} / 3</Row>
                  <Row label="Coverage">{formatGen(selected.coverage)} GEN</Row>
                  <Row label={selected.status === "ACTIVE" ? "Expires in" : "Status"}>{selected.status === "ACTIVE" ? formatDuration(selected.expiresAt - now) : selected.status.replace("_", " ").toLowerCase()}</Row>
                </dl>
              </Card>

              {selected.status === "BREACH_PENDING" && (
                <div role="alert" className="rounded-xl border border-danger/40 bg-danger-dim px-5 py-4 text-sm text-danger">
                  <p className="font-semibold">SLA breach confirmed — {formatGen(selected.coverage)} GEN reserved.</p>
                  <p className="mt-1 text-ink/80">A fresh validator round re-verifies the endpoint once the grace period ends. If it is still failing, the payout is released to the policyholder automatically.</p>
                </div>
              )}
              {selected.status === "PAID" && (
                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 backdrop-blur-md px-5 py-4 text-sm">
                  <span className="font-semibold text-danger">Claim paid.</span> {formatGen(selected.payout)} GEN of {formatGen(selected.coverage)} GEN coverage was released to {shortAddress(selected.holder)}.
                </div>
              )}

              <Card title="Latency vs SLA" action={<span className="text-xs text-muted">{series.length} probes</span>}>
                <LatencyChart points={series} limitMs={selected.maxLatencyMs} />
                <div className="mt-3 flex gap-0.5" aria-label="Probe history" role="img">
                  {series.slice(-60).map((p) => <span key={p.index} title={formatTime(p.time)} className={`h-3 flex-1 rounded-sm ${p.ok ? "bg-pulse/70" : "bg-danger"}`} />)}
                </div>
              </Card>

              <Card title="Validator consensus" action={lastObs && <span className="text-xs text-muted">{formatTime(lastObs.time)}</span>}>
                {lastObs ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted">{lastObs.detail}</p>
                    <ConsensusBreakdown votes={lastObs.votes ?? votesByIncident[lastObs.index]} />
                  </div>
                ) : <p className="text-sm text-muted">No probe has been run on this policy yet.</p>}
              </Card>

              <Card title="Actions">
                {(() => {
                  const pe = probeEligibility(selected, now);
                  const se = settleEligibility(selected, now);
                  const expirable = (selected.status === "ACTIVE" && now >= selected.expiresAt) || (selected.status === "BREACH_PENDING" && now > selected.settleAt + SETTLE_WINDOW_SECONDS);
                  return (
                    <div className="space-y-4">
                      <div className="flex flex-wrap gap-3">
                        {selected.status !== "BREACH_PENDING" && (
                          <Button loading={busy} disabled={!pe.can || !canTransact} onClick={() => void triggerProbe(selected.id)}>Trigger probe</Button>
                        )}
                        {selected.status === "BREACH_PENDING" && (
                          <Button variant="danger" loading={busy} disabled={!se.can || !canTransact} onClick={() => void settleClaim(selected.id)}>Settle claim</Button>
                        )}
                        {expirable && <Button variant="ghost" loading={busy} disabled={!canTransact} onClick={() => void expirePolicy(selected.id)}>Expire policy</Button>}
                      </div>
                      <p className="text-xs text-muted">
                        {!canTransact ? "Connect a wallet to transact. "
                          : selected.status === "BREACH_PENDING" ? (se.reason ?? "Ready: a fresh consensus round will decide the payout. ")
                          : (pe.reason ?? "Ready. ")}
                        {metrics && `Bond ${formatGen(metrics.probeBond, 4)} GEN — refunded when a failure is confirmed, forfeited to underwriters when the endpoint is healthy.`}
                      </p>
                    </div>
                  );
                })()}
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
