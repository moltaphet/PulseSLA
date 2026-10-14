/** Normalise chain responses (genlayer-js may return Map / object / string-encoded JSON) into typed models. */
import type {
  Endpoint, Incident, IncidentKind, Policy, PolicyStatus, PoolMetrics, ProbeReason, UnderwriterPosition, Verdict,
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
    netAssets: r.net_assets !== undefined ? big(r.net_assets) : big(r.tvl) - big(r.reserved_payouts),
    totalShares: big(r.total_shares),
    sharePrice: big(r.share_price),
    lockedCoverage: big(r.locked_coverage),
    reservedPayouts: big(r.reserved_payouts),
    owedPayouts: big(r.owed_payouts),
    stagedClaims: big(r.staged_claims),
    listedEndpoints: num(r.listed_endpoints),
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
    epochPaid: big(r.epoch_paid),
    epochCeiling: big(r.epoch_ceiling),
    maxEpochPayoutBps: num(r.max_epoch_payout_bps),
  };
}

export function parseUnderwriter(raw: unknown): UnderwriterPosition {
  const r = toRecord(raw);
  return { shares: big(r.shares), value: big(r.value), withdrawable: big(r.withdrawable) };
}

const STATUSES: readonly PolicyStatus[] = ["ACTIVE", "BREACH_PENDING", "VESTING", "PAID", "EXPIRED", "LAPSED"];

export function parsePolicy(raw: unknown): Policy {
  const r = toRecord(raw);
  const status = str(r.status) as PolicyStatus;
  return {
    id: num(r.id),
    holder: str(r.holder).toLowerCase(),
    endpointId: str(r.endpoint_id),
    endpointUrl: str(r.endpoint_url),
    host: str(r.host),
    apex: str(r.apex) || str(r.host),
    chainId: num(r.chain_id),
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
    inconclusiveRounds: num(r.inconclusive_rounds),
    downtimeSecs: num(r.downtime_secs),
    consecutiveFailures: num(r.consecutive_failures),
    outageStartedAt: num(r.outage_started_at),
    outageBlocks: num(r.outage_blocks),
    baselineOk: r.baseline_ok === true,
    lastProbeAt: num(r.last_probe_at),
    lastBlock: num(r.last_block),
    lastRefHead: num(r.last_ref_head),
    lastReason: str(r.last_reason) as ProbeReason | "",
    lastOk: r.last_ok === true,
    breachAt: num(r.breach_at),
    settleAt: num(r.settle_at),
    claimCount: num(r.claim_count),
    payout: big(r.payout),
    released: big(r.released),
    releasable: big(r.releasable),
    vestStart: num(r.vest_start),
  };
}

export function parseEndpoint(raw: unknown): Endpoint {
  const r = toRecord(raw);
  return {
    id: str(r.endpoint_id),
    provider: str(r.provider),
    domain: str(r.domain),
    url: str(r.url),
    host: str(r.host),
    apex: str(r.apex) || str(r.host),
    chainId: num(r.chain_id),
    attestation: str(r.attestation),
    listedAt: num(r.listed_at),
    insurableFrom: num(r.insurable_from),
    status: str(r.status) === "DELISTED" ? "DELISTED" : "LISTED",
  };
}

export function parseEndpoints(raw: unknown): Endpoint[] {
  return (Array.isArray(raw) ? raw : []).map(parseEndpoint).filter((e) => e.id !== "");
}

const KINDS: readonly IncidentKind[] = [
  "POLICY_CREATED", "PROBE", "BREACH_STAGED", "BREACH_CONFIRMED_VESTING", "CLAIM_DISMISSED", "PAYOUT_RELEASED",
  "POLICY_EXPIRED", "CLAIM_LAPSED", "ENDPOINT_LISTED", "ENDPOINT_DELISTED", "GOVERNOR_CHANGED",
];
const VERDICTS: readonly Verdict[] = ["HEALTHY", "FAILING", "INCONCLUSIVE"];

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
    const verdict = str(r.verdict) as Verdict;
    inc.verdict = VERDICTS.includes(verdict) ? verdict : r.ok ? "HEALTHY" : "FAILING";
    inc.reason = str(r.reason) as ProbeReason;
    inc.status = num(r.status);
    inc.block = num(r.block);
    inc.refHead = num(r.ref_head);
    inc.refsOk = num(r.refs_ok);
    inc.refsTotal = num(r.refs_total);
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
