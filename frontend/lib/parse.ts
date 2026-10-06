/** Normalise chain responses (genlayer-js may return Map / object / string-encoded JSON) into typed models. */
import type {
  Incident, IncidentKind, Policy, PolicyStatus, PoolMetrics, ProbeMode, ProbeReason, UnderwriterPosition,
} from "./types";

export function toRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return toRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  if (raw instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of raw.entries()) out[String(k)] = v instanceof Map ? toRecord(v) : v;
    return out;
  }
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export function parsePoolMetrics(raw: unknown): PoolMetrics {
  const r = toRecord(raw);
  return {
    tvl: big(r.tvl),
    totalShares: big(r.total_shares),
    sharePrice: big(r.share_price),
    lockedCoverage: big(r.locked_coverage),
    reservedPayouts: big(r.reserved_payouts),
    freeLiquidity: big(r.free_liquidity),
    utilizationBps: num(r.utilization_bps),
    apyBps: num(r.apy_bps),
    activePolicies: num(r.active_policies),
    totalPolicies: num(r.total_policies),
    totalPremiums: big(r.total_premiums),
    totalPayouts: big(r.total_payouts),
    totalBondForfeits: big(r.total_bond_forfeits),
    totalProbes: num(r.total_probes),
    totalBreaches: num(r.total_breaches),
    activationDelay: num(r.activation_delay),
    claimGrace: num(r.claim_grace),
    probeBond: big(r.probe_bond),
    solvent: r.solvent === true,
  };
}

export function parseUnderwriter(raw: unknown): UnderwriterPosition {
  const r = toRecord(raw);
  return { shares: big(r.shares), value: big(r.value), withdrawable: big(r.withdrawable) };
}

const STATUSES: readonly PolicyStatus[] = ["ACTIVE", "BREACH_PENDING", "PAID", "EXPIRED", "LAPSED"];

export function parsePolicy(raw: unknown): Policy {
  const r = toRecord(raw);
  const status = str(r.status) as PolicyStatus;
  return {
    id: num(r.id),
    holder: str(r.holder).toLowerCase(),
    endpointUrl: str(r.endpoint_url),
    host: str(r.host),
    probeMode: (str(r.probe_mode) === "http" ? "http" : "rpc") as ProbeMode,
    maxLatencyMs: num(r.max_latency_ms),
    minUptimeBps: num(r.min_uptime_bps),
    probeInterval: num(r.probe_interval),
    coverage: big(r.coverage),
    premium: big(r.premium),
    createdAt: num(r.created_at),
    activeFrom: num(r.active_from),
    expiresAt: num(r.expires_at),
    status: STATUSES.includes(status) ? status : "ACTIVE",
    samplesTotal: num(r.samples_total),
    samplesOk: num(r.samples_ok),
    uptimeBps: num(r.uptime_bps),
    consecutiveFailures: num(r.consecutive_failures),
    baselineOk: r.baseline_ok === true,
    lastProbeAt: num(r.last_probe_at),
    lastBlock: num(r.last_block),
    lastLatencyMs: num(r.last_latency_ms),
    lastReason: str(r.last_reason) as ProbeReason | "",
    lastOk: r.last_ok === true,
    settleAt: num(r.settle_at),
    claimCount: num(r.claim_count),
    payout: big(r.payout),
  };
}

const KINDS: readonly IncidentKind[] = [
  "POLICY_CREATED", "PROBE", "BREACH_CONFIRMED", "CLAIM_DISMISSED", "PAYOUT", "POLICY_EXPIRED", "CLAIM_LAPSED",
];

/** Incidents are stored on-chain as JSON strings. */
export function parseIncident(raw: unknown): Incident | null {
  const r = toRecord(raw);
  const kind = str(r.kind) as IncidentKind;
  if (!KINDS.includes(kind)) return null;
  const inc: Incident = {
    index: num(r.i),
    time: num(r.t),
    policyId: num(r.policy_id),
    kind,
    detail: str(r.detail),
    by: str(r.by).toLowerCase(),
  };
  if (typeof r.ok === "boolean") {
    inc.ok = r.ok;
    inc.reason = str(r.reason) as ProbeReason;
    inc.status = num(r.status);
    inc.latencyMs = num(r.latency_ms);
    inc.block = num(r.block);
  }
  return inc;
}

export function parseIncidents(raw: unknown): Incident[] {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(parseIncident).filter((i): i is Incident => i !== null);
}

export function parsePolicies(raw: unknown): Policy[] {
  return (Array.isArray(raw) ? raw : []).map(parsePolicy);
}
