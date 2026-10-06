import { formatBps } from "@/lib/units";
import type { Tone } from "@/lib/types";

/** Measured uptime vs the policy's SLA floor. */
export function UptimeBadge({ uptimeBps, slaBps, samples }: { uptimeBps: number; slaBps: number; samples: number }) {
  const tone: Tone = samples === 0 ? "muted" : uptimeBps >= slaBps ? "pulse" : "danger";
  const ring = { pulse: "border-pulse/40 bg-pulse-dim text-pulse", danger: "border-danger/40 bg-danger-dim text-danger", muted: "border-line bg-panel-2 text-muted", warn: "", capital: "" }[tone];
  return (
    <div className={`inline-flex flex-col rounded-2xl border px-5 py-3 ${ring}`} role="group" aria-label={`Uptime ${formatBps(uptimeBps)} against SLA ${formatBps(slaBps)}`}>
      <span className="text-[10px] font-semibold uppercase tracking-widest opacity-80">Uptime</span>
      <span className="num text-4xl font-bold" data-testid="uptime-value">{samples === 0 ? "—" : formatBps(uptimeBps)}</span>
      <span className="num text-xs opacity-80">SLA {formatBps(slaBps)} · {samples} {samples === 1 ? "sample" : "samples"}</span>
    </div>
  );
}
