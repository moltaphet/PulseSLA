import type { Incident, Policy, Tone, Verdict } from "./types";
import { MAX_LAG_BLOCKS, MIN_REFERENCES, PAYOUT_COOLDOWN_SECS } from "./pricing";
import { formatDuration } from "./units";

export interface Health {
  label: string;
  tone: Tone;
  live: boolean;
}

/** One-word operational state of an insured endpoint. */
export function policyHealth(p: Policy, now: number): Health {
  switch (p.status) {
    case "VESTING": return { label: "Payout vesting", tone: "danger", live: true };
    case "PAID": return { label: "Claim paid", tone: "danger", live: false };
    case "EXPIRED": return { label: "Expired", tone: "muted", live: false };
    case "LAPSED": return { label: "Claim lapsed", tone: "muted", live: false };
    case "BREACH_PENDING": return { label: "Breach staged", tone: "danger", live: true };
    default: break;
  }
  if (now < p.activeFrom) return { label: "Activating", tone: "capital", live: false };
  if (p.lastProbeAt === 0) return { label: "Awaiting first probe", tone: "muted", live: false };
  if (p.consecutiveFailures > 0) return { label: "Degraded", tone: "warn", live: true };
  return { label: "Healthy", tone: "pulse", live: true };
}

export interface Eligibility {
  can: boolean;
  reason: string | null;
}

/** Whether `trigger_probe` would currently be accepted for this policy. */
export function probeEligibility(p: Policy, now: number): Eligibility {
  if (p.status !== "ACTIVE") return { can: false, reason: "Only ACTIVE policies can be probed" };
  if (now < p.activeFrom) return { can: false, reason: `Cover activates in ${formatDuration(p.activeFrom - now)}` };
  if (now >= p.expiresAt) return { can: false, reason: "Policy term has ended" };
  if (p.lastProbeAt > 0 && now < p.lastProbeAt + p.probeInterval) {
    return { can: false, reason: `Next probe allowed in ${formatDuration(p.lastProbeAt + p.probeInterval - now)}` };
  }
  return { can: true, reason: null };
}

/** Whether `settle_claim` would currently be accepted. */
export function settleEligibility(p: Policy, now: number): Eligibility {
  if (p.status !== "BREACH_PENDING") return { can: false, reason: "No staged claim" };
  if (now < p.settleAt) return { can: false, reason: `Grace period ends in ${formatDuration(p.settleAt - now)}` };
  return { can: true, reason: null };
}

/** Whether `release_payout` would currently pay something. */
export function releaseEligibility(p: Policy, now: number): Eligibility {
  if (p.status !== "VESTING") return { can: false, reason: "No vesting payout" };
  if (p.releasable <= 0n) {
    const t = p.vestStart + PAYOUT_COOLDOWN_SECS;
    return { can: false, reason: now < t ? `Cooldown ends in ${formatDuration(t - now)}` : "Nothing has vested since the last release" };
  }
  return { can: true, reason: null };
}

export function isLive(p: Policy): boolean {
  return p.status === "ACTIVE" || p.status === "BREACH_PENDING";
}

export interface ProbePoint {
  index: number;
  time: number;
  verdict: Verdict;
  ok: boolean;
  reason: string;
  status: number;
  block: number;
  refHead: number;
  /** Blocks the target trailed the corroborated reference head, or null when no height was observed. */
  lagBlocks: number | null;
}

const OBSERVATION_KINDS = new Set(["PROBE", "BREACH_CONFIRMED_VESTING", "CLAIM_DISMISSED"]);

/** Corroborated observations recorded for a policy, oldest first. */
export function probeSeries(incidents: readonly Incident[], policyId: number): ProbePoint[] {
  return incidents
    .filter((i) => i.policyId === policyId && i.ok !== undefined && OBSERVATION_KINDS.has(i.kind))
    .map((i) => {
      const block = i.block ?? -1;
      const refHead = i.refHead ?? -1;
      return {
        index: i.index, time: i.time, verdict: i.verdict ?? (i.ok ? "HEALTHY" : "FAILING"), ok: i.ok === true,
        reason: i.reason ?? "", status: i.status ?? 0, block, refHead,
        lagBlocks: block > 0 && refHead > 0 ? Math.max(0, refHead - block) : null,
      };
    })
    .sort((a, b) => a.time - b.time || a.index - b.index);
}

export interface Check {
  id: "reference" | "status" | "block" | "verdict";
  label: string;
  expected: string;
  observed: string;
  pass: boolean | null;
}

/** The corroborated SLA predicates applied to one observation, for the incident inspector's "why". */
export function probeChecks(inc: Incident): Check[] {
  if (inc.ok === undefined) return [];
  const verdict = inc.verdict ?? (inc.ok ? "HEALTHY" : "FAILING");
  const baseline = verdict !== "INCONCLUSIVE" || inc.reason === "RATE_LIMITED";
  const reached = inc.reason !== "UNREACHABLE";
  const payloadBad = inc.reason === "BAD_PAYLOAD";
  const stale = inc.reason === "STALE_BLOCK";
  const total = inc.refsTotal ?? 0;
  const quorum = Math.floor(total / 2) + 1;
  const checks: Check[] = [
    {
      id: "reference", label: "Reference baseline", expected: `≥ ${quorum} of ${total || MIN_REFERENCES} providers healthy`,
      observed: total ? `${inc.refsOk ?? 0} of ${total} healthy` : "unavailable", pass: baseline,
    },
    {
      id: "status", label: "HTTP status", expected: "200",
      observed: !reached ? "no response" : inc.status ? String(inc.status) : "n/a", pass: !baseline ? null : reached && inc.status === 200,
    },
    {
      id: "block", label: "Block height vs reference head", expected: `within ${MAX_LAG_BLOCKS} blocks`,
      observed: !reached || (inc.status ?? 0) !== 200 || payloadBad ? "unavailable"
        : `block ${inc.block} vs head ${inc.refHead}${stale ? " (stale)" : ""}`,
      pass: !baseline || !reached || inc.status !== 200 ? null : payloadBad ? false : !stale,
    },
    {
      id: "verdict", label: "Corroborated verdict", expected: "healthy",
      observed: verdict === "INCONCLUSIVE" ? `inconclusive (${(inc.reason ?? "").toLowerCase().replace(/_/g, " ")})`
        : inc.ok ? "healthy" : (inc.reason ?? "failing").toLowerCase().replace(/_/g, " "),
      pass: verdict === "INCONCLUSIVE" ? null : inc.ok,
    },
  ];
  return checks;
}
