import type { ConsensusVote } from "@/lib/types";
import { Pill } from "./ui";

/** Roll call of the validator round: who agreed with the leader's verdict, and what each one saw. */
export function ConsensusBreakdown({ votes, emptyNote }: { votes?: ConsensusVote[]; emptyNote?: string }) {
  if (!votes || votes.length === 0) {
    return <p className="text-sm text-muted">{emptyNote ?? "No vote roll recorded for this observation. The contract stores the leader's view; the full roll is in the transaction's consensus data."}</p>;
  }
  const agree = votes.filter((v) => v.agree).length;
  return (
    <div data-testid="consensus-breakdown">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">{agree} of {votes.length} validators agree</span>
        <Pill tone={agree * 2 > votes.length ? "pulse" : "danger"}>{agree * 2 > votes.length ? "Consensus reached" : "No consensus"}</Pill>
      </div>
      <div className="mt-2 flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`${agree} agree, ${votes.length - agree} disagree`}>
        {votes.map((v) => <span key={v.validator} className={`flex-1 ${v.agree ? "bg-pulse" : "bg-danger"}`} />)}
      </div>
      <ul className="mt-3 divide-y divide-line text-sm">
        {votes.map((v) => (
          <li key={v.validator} className="flex items-center justify-between gap-3 py-1.5">
            <span className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${v.agree ? "bg-pulse" : "bg-danger"}`} aria-hidden />
              <span className="num text-xs text-muted">{v.validator}</span>
              {v.role === "leader" && <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">leader</span>}
            </span>
            <span className="num text-right text-xs text-muted">
              {v.reason !== undefined
                ? `${(v.reason ?? "").toLowerCase().replace(/_/g, " ")}${v.status ? ` · HTTP ${v.status}` : ""}${v.latencyMs !== undefined ? ` · ${v.latencyMs} ms` : ""}`
                : v.agree ? "agrees" : "disagrees"}
            </span>
            <span className="sr-only">{v.agree ? "agrees" : "disagrees"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
