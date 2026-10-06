"use client";

import { useProtocol } from "@/lib/hooks/useProtocol";
import { formatGen } from "@/lib/units";
import { Spinner } from "./ui";

export function TxBanner() {
  const { tx, dismissTx } = useProtocol();
  if (tx.phase === "idle") return null;

  const tone =
    tx.phase === "pending" ? "border-capital/40 bg-capital-dim text-capital"
    : tx.phase === "success" ? "border-pulse/40 bg-pulse-dim text-pulse"
    : "border-danger/40 bg-danger-dim text-danger";

  let body: string;
  if (tx.phase === "pending") body = "Waiting for validator consensus…";
  else if (tx.phase === "error") body = tx.message;
  else {
    const { votes, outcome } = tx.receipt;
    const parts: string[] = [];
    if (votes?.length) parts.push(`${votes.filter((v) => v.agree).length}/${votes.length} validators agreed`);
    if (outcome?.paid) parts.push(`payout ${formatGen(outcome.payout ?? 0n)} GEN released`);
    else if (outcome?.paid === false) parts.push("claim dismissed: endpoint recovered");
    else if (outcome?.breachStaged) parts.push("breach confirmed — claim staged");
    else if (outcome?.ok !== undefined) parts.push(outcome.ok ? "endpoint healthy" : `endpoint failing (${(outcome.reason ?? "").toLowerCase().replace(/_/g, " ")})`);
    body = parts.length ? parts.join(" · ") : "Confirmed";
  }

  return (
    <div role="status" aria-live="polite" className={`border-b px-4 py-2.5 text-sm sm:px-6 ${tone}`}>
      <div className="mx-auto flex max-w-7xl items-center gap-3">
        {tx.phase === "pending" && <Spinner />}
        <span className="font-semibold">{tx.summary}</span>
        <span className="min-w-0 flex-1 truncate text-ink/80">{body}</span>
        {tx.phase !== "pending" && (
          <button type="button" onClick={dismissTx} aria-label="Dismiss notification" className="rounded px-2 py-0.5 text-xs text-ink/70 hover:text-ink">Dismiss</button>
        )}
      </div>
    </div>
  );
}
