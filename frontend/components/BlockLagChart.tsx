import type { ProbePoint } from "@/lib/policyState";
import { MAX_LAG_BLOCKS } from "@/lib/pricing";
import { formatTime } from "@/lib/units";

const W = 640;
const H = 220;
const PAD = { l: 48, r: 12, t: 14, b: 26 };

/**
 * How far the insured endpoint trailed the corroborated reference head at each round, against the staleness limit.
 * Rounds with no observable height (unreachable, HTTP error, bad payload) are pinned to the top edge in red;
 * inconclusive rounds are shown hollow because they never count for or against the provider.
 */
export function BlockLagChart({ points, limit = MAX_LAG_BLOCKS, max = 80 }: { points: ProbePoint[]; limit?: number; max?: number }) {
  const data = points.slice(-max);
  if (data.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted">No corroborated rounds recorded yet</div>;
  }
  const observed = data.map((p) => p.lagBlocks).filter((l): l is number => l !== null);
  const top = Math.max(limit * 1.6, Math.min(Math.max(0, ...observed), limit * 4));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (lag: number | null) => PAD.t + plotH - (Math.min(lag ?? top, top) / top) * plotH;
  const failing = data.filter((p) => p.verdict === "FAILING").length;
  const inconclusive = data.filter((p) => p.verdict === "INCONCLUSIVE").length;

  return (
    <figure className="w-full">
      <svg role="img"
        aria-label={`Block lag behind the reference head over the last ${data.length} rounds against the ${limit} block limit; ${failing} failing, ${inconclusive} inconclusive`}
        viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <title>Blocks behind the reference head</title>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + plotH * (1 - f)} y2={PAD.t + plotH * (1 - f)} stroke="#3f3f46" strokeWidth="1" />
            <text x={PAD.l - 8} y={PAD.t + plotH * (1 - f) + 4} textAnchor="end" fontSize="10" fill="#a1a1aa" className="num">{Math.round(top * f)}</text>
          </g>
        ))}
        <line data-testid="sla-line" x1={PAD.l} x2={W - PAD.r} y1={y(limit)} y2={y(limit)} stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="5 4" />
        <text x={W - PAD.r} y={y(limit) - 5} textAnchor="end" fontSize="10" fill="#fbbf24" className="num">stale beyond {limit} blocks</text>
        {data.map((p, i) => {
          const inc = p.verdict === "INCONCLUSIVE";
          const bad = p.verdict === "FAILING";
          return (
            <circle key={p.index} data-testid="probe-point" data-ok={p.ok} data-verdict={p.verdict} data-unobserved={p.lagBlocks === null || undefined}
              cx={x(i)} cy={y(p.lagBlocks)} r={bad ? 4.5 : 3}
              fill={inc ? "none" : bad ? "#fb4b63" : "#10b981"} stroke={inc ? "#a1a1aa" : "#09090b"} strokeWidth={inc ? 1.5 : 1}>
              <title>{`${formatTime(p.time)} · ${p.verdict.toLowerCase()}${p.ok ? "" : ` (${p.reason.toLowerCase().replace(/_/g, " ")})`}${p.lagBlocks !== null ? ` · ${p.lagBlocks} blocks behind` : " · height not observed"}`}</title>
            </circle>
          );
        })}
        <text x={PAD.l} y={H - 6} fontSize="10" fill="#a1a1aa" className="num">{formatTime(data[0].time).slice(5, 16)}</text>
        <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="10" fill="#a1a1aa" className="num">{formatTime(data[data.length - 1].time).slice(5, 16)}</text>
      </svg>
    </figure>
  );
}
