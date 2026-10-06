"use client";

import { useState } from "react";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { previewDeposit, previewWithdrawBurn, validateDeposit, validateWithdraw } from "@/lib/underwriting";
import { formatBps, formatGen, formatDuration, ATTO } from "@/lib/units";
import { Button, Card, Dot, EmptyState, Field, Meter, Pill, Row, Segmented, Stat } from "./ui";

export function UnderwritingPortal() {
  const { metrics, position, balance, canTransact, deposit, withdraw, loading, mode, tx } = useProtocol();
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [input, setInput] = useState("");
  const busy = tx.phase === "pending";

  if (loading && !metrics) return <p className="text-sm text-muted" role="status">Loading pool state…</p>;
  if (!metrics) return <EmptyState title="Pool state unavailable">The protocol could not be read. Check the network and contract address.</EmptyState>;

  const pos = position ?? { shares: 0n, value: 0n, withdrawable: 0n };
  const check = tab === "deposit" ? validateDeposit(input, balance) : validateWithdraw(input, pos.value, pos.withdrawable);
  const preview =
    check.amount === null ? null
    : tab === "deposit" ? { label: "Shares minted", value: previewDeposit(check.amount, metrics.tvl, metrics.totalShares) }
    : { label: "Shares burned", value: previewWithdrawBurn(check.amount, metrics.tvl, metrics.totalShares) };
  const max = tab === "deposit" ? balance : pos.withdrawable;

  const submit = async () => {
    if (check.amount === null) return;
    const ok = tab === "deposit" ? await deposit(check.amount) : await withdraw(check.amount);
    if (ok) setInput("");
  };

  const total = Number(metrics.tvl);
  const active = Number(metrics.lockedCoverage - metrics.reservedPayouts);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Underwriting portal</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Deposit GEN into the shared liquidity pool. You earn the premiums of every policy and absorb confirmed payouts pro rata.
          Capital backing live coverage is locked until the policy ends.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat large className="lg:col-span-2" label="Pool TVL" tone="capital" value={`${formatGen(metrics.tvl, 2)} GEN`}
          badge={<Pill tone="capital">{metrics.activePolicies} live {metrics.activePolicies === 1 ? "policy" : "policies"}</Pill>}
          hint={`${formatGen(metrics.totalPremiums, 2)} GEN earned in premiums to date`} />
        <Stat label="Est. APY" tone="pulse" value={formatBps(metrics.apyBps)} badge={<Pill tone="pulse">yield</Pill>}
          hint="Annualised premiums of live policies ÷ TVL" />
        <Stat label="Pool solvency" tone={metrics.solvent ? "pulse" : "danger"}
          value={metrics.lockedCoverage > 0n ? `${(Number((metrics.tvl * 100n) / metrics.lockedCoverage) / 100).toFixed(1)}× cover` : "Fully free"}
          badge={<Pill tone={metrics.solvent ? "pulse" : "danger"}><Dot tone={metrics.solvent ? "pulse" : "danger"} live />{metrics.solvent ? "Invariant holds" : "VIOLATED"}</Pill>}
          hint="Assets ÷ locked coverage" />
        <Stat className="lg:col-span-2" label="Utilization" tone={metrics.utilizationBps > 7000 ? "warn" : "muted"} value={formatBps(metrics.utilizationBps)}
          badge={<Pill tone="muted">cap {formatBps(8000, 0)}</Pill>} hint="Share of TVL locked behind live coverage">
          <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-violet-500" style={{ width: `${Math.min(100, metrics.utilizationBps / 80)}%` }} /></div>
        </Stat>
        <Stat className="lg:col-span-2" label="Share price" value={`${(Number((metrics.sharePrice * 10_000n) / ATTO) / 10_000).toFixed(4)}`} hint="GEN per pool share" badge={<Pill tone="muted">{formatGen(metrics.totalShares, 2)} shares</Pill>} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" title="Manage capital" action={<Segmented label="Action" value={tab} onChange={(t) => { setTab(t); setInput(""); }} options={[{ value: "deposit", label: "Deposit" }, { value: "withdraw", label: "Withdraw" }]} />}>
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
            <Field id="amount" label={tab === "deposit" ? "Amount to deposit" : "Amount to withdraw"} inputMode="decimal" autoComplete="off" placeholder="0.0"
              value={input} onChange={(e) => setInput(e.target.value)} error={check.error} suffix={
                <span className="flex items-center gap-2">
                  GEN
                  <button type="button" disabled={max === null || max === 0n} onClick={() => max !== null && setInput(formatGen(max, 18).replace(/,/g, ""))}
                    className="rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold uppercase text-capital hover:border-capital disabled:text-faint">Max</button>
                </span>}
              hint={tab === "deposit" ? (balance !== null ? `Wallet balance ${formatGen(balance)} GEN` : undefined) : `Withdrawable now ${formatGen(pos.withdrawable)} GEN of ${formatGen(pos.value)} GEN`} />
            {preview && (
              <dl className="rounded-lg border border-line bg-bg px-4 py-2">
                <Row label={preview.label}>{formatGen(preview.value, 6)}</Row>
                <Row label="Share price">{(Number((metrics.sharePrice * 10_000n) / ATTO) / 10_000).toFixed(4)} GEN</Row>
              </dl>
            )}
            <Button type="submit" variant="capital" className="w-full" loading={busy} disabled={check.amount === null || !canTransact}>
              {!canTransact ? "Connect a wallet to continue" : tab === "deposit" ? "Deposit to pool" : "Withdraw from pool"}
            </Button>
            {mode === "live" && <p className="text-xs text-faint">Writes go through GenLayer consensus and take a few seconds to be decided.</p>}
          </form>
        </Card>

        <div className="space-y-6 lg:col-span-2">
          <Card title="Your position">
            {position && position.shares > 0n ? (
              <dl>
                <Row label="Value">{formatGen(pos.value)} GEN</Row>
                <Row label="Shares">{formatGen(pos.shares, 4)}</Row>
                <Row label="Withdrawable">{formatGen(pos.withdrawable)} GEN</Row>
                <Row label="Locked behind cover">{formatGen(pos.value - pos.withdrawable)} GEN</Row>
              </dl>
            ) : (
              <p className="text-sm text-muted">No capital deposited yet. Deposit to start earning premiums.</p>
            )}
          </Card>
          <Card title="Liquidity composition" action={<Pill tone={metrics.solvent ? "pulse" : "danger"}>{metrics.solvent ? "Solvent" : "INSOLVENT"}</Pill>}>
            <Meter label="Pool liquidity composition" total={total} segments={[
              { label: `Free ${formatGen(metrics.freeLiquidity, 2)}`, value: Number(metrics.freeLiquidity), tone: "pulse" },
              { label: `Backing live cover ${formatGen(BigInt(Math.max(active, 0)), 2)}`, value: Math.max(active, 0), tone: "capital" },
              { label: `Reserved for claims ${formatGen(metrics.reservedPayouts, 2)}`, value: Number(metrics.reservedPayouts), tone: "danger" },
            ]} />
            <p className="mt-3 text-xs text-muted">Invariant: locked coverage never exceeds pool assets, so a payout can never overdraw the pool.</p>
          </Card>
        </div>
      </div>

      <Card title="Pool ledger">
        <dl className="grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Premiums earned">{formatGen(metrics.totalPremiums)} GEN</Row>
          <Row label="Payouts made">{formatGen(metrics.totalPayouts)} GEN</Row>
          <Row label="Probe-bond forfeits">{formatGen(metrics.totalBondForfeits)} GEN</Row>
          <Row label="Probes run">{metrics.totalProbes}</Row>
          <Row label="Breaches confirmed">{metrics.totalBreaches}</Row>
          <Row label="Claim grace period">{formatDuration(metrics.claimGrace)}</Row>
        </dl>
      </Card>
    </div>
  );
}
