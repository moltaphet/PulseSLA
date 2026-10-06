import type { ProbePoint } from "@/lib/policyState";
import { formatTime } from "@/lib/units";

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 14, b: 26 };

/** Probe latency over time against the policy's SLA limit. Failing probes are red; points above the plot are pinned to its top edge. */
export function LatencyChart({ points, limitMs, max = 80 }: { points: ProbePoint[]; limitMs: number; max?: number }) {
  const data = points.slice(-max);
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted">No probes recorded yet</div>;
  }
  const top = Math.max(limitMs * 1.6, Math.min(Math.max(...data.map((p) => p.latencyMs)), limitMs * 3));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (ms: number) => PAD.t + plotH - (Math.min(ms, top) / top) * plotH;
  const line = data.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.latencyMs).toFixed(1)}`).join(" ");
  const fails = data.filter((p) => !p.ok).length;

  return (
    <figure className="w-full">
      <svg role="img" aria-label={`Latency of the last ${data.length} probes against the ${limitMs} millisecond limit; ${fails} failed`}
        viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <title>Probe latency (ms)</title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * (1 - f)} y2={PAD.t + plotH * (1 - f)} stroke="#3f3f46" strokeWidth="1" />
            <text x={PAD.l - 8} y={PAD.t + plotH * (1 - f) + 4} textAnchor="end" fontSize="10" fill="#a1a1aa" className="num">{Math.round(top * f)}</text>
          </g>
        ))}
        <line data-testid="sla-line" x1={PAD.l} x2={W - PAD.r} y1={y(limitMs)} y2={y(limitMs)} stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="5 4" />
        <text x={W - PAD.r} y={y(limitMs) - 5} textAnchor="end" fontSize="10" fill="#fbbf24" className="num">SLA {limitMs} ms</text>
        <path d={line} fill="none" stroke="#71717a" strokeWidth="1.5" />
        {data.map((p, i) => (
          <circle key={p.index} data-testid="probe-point" data-ok={p.ok} data-clipped={p.latencyMs > top || undefined}
            cx={x(i)} cy={y(p.latencyMs)} r={p.ok ? 3 : 4.5} fill={p.ok ? "#10b981" : "#fb4b63"} stroke="#09090b" strokeWidth="1">
            <title>{`${formatTime(p.time)} · ${p.ok ? "healthy" : p.reason.toLowerCase().replace(/_/g, " ")} · ${p.latencyMs} ms${p.status ? ` · HTTP ${p.status}` : ""}`}</title>
          </circle>
        ))}
        <text x={PAD.l} y={H - 6} fontSize="10" fill="#a1a1aa" className="num">{formatTime(data[0].time).slice(5, 16)}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="10" fill="#a1a1aa" className="num">{formatTime(data[data.length - 1].time).slice(5, 16)}</text>
      </svg>
    </figure>
  );
}
