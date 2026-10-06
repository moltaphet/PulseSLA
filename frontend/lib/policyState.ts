import type { Incident, Policy, Tone } from "./types";
import { formatDuration } from "./units";

export interface Health {
  label: string;
  tone: Tone;
  live: boolean;
}

/** One-word operational state of an insured endpoint. */
export function policyHealth(p: Policy, now: number): Health {
  switch (p.status) {
    case "PAID": return { label: "Claim paid", tone: "danger", live: false };
    case "EXPIRED": return { label: "Expired", tone: "muted", live: false };
    case "LAPSED": return { label: "Claim lapsed", tone: "muted", live: false };
    case "BREACH_PENDING": return { label: "Breach confirmed", tone: "danger", live: true };
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

export function isLive(p: Policy): boolean {
  return p.status === "ACTIVE" || p.status === "BREACH_PENDING";
}

export interface ProbePoint {
  index: number;
  time: number;
  latencyMs: number;
  ok: boolean;
  reason: string;
  status: number;
  block: number;
}

/** Observations recorded for a policy, oldest first. */
export function probeSeries(incidents: readonly Incident[], policyId: number): ProbePoint[] {
  return incidents
    .filter((i) => i.policyId === policyId && i.ok !== undefined && (i.kind === "PROBE" || i.kind === "PAYOUT" || i.kind === "CLAIM_DISMISSED"))
    .map((i) => ({
      index: i.index, time: i.time, latencyMs: i.latencyMs ?? 0, ok: i.ok === true, reason: i.reason ?? "", status: i.status ?? 0, block: i.block ?? -1,
    }))
    .sort((a, b) => a.time - b.time || a.index - b.index);
}

export interface Check {
  id: "status" | "latency" | "block" | "verdict";
  label: string;
  expected: string;
  observed: string;
  pass: boolean | null;
}

/** The SLA predicates applied to one observation, for the incident inspector's "why". */
export function probeChecks(inc: Incident, policy: Policy | undefined): Check[] {
  if (inc.ok === undefined) return [];
  const max = policy?.maxLatencyMs ?? 0;
  const rpc = (policy?.probeMode ?? "rpc") === "rpc";
  const reached = inc.reason !== "UNREACHABLE";
  const checks: Check[] = [
    { id: "status", label: "HTTP status", expected: "200", observed: reached ? String(inc.status) : "no response", pass: reached && inc.status === 200 },
    {
      id: "latency", label: "Response latency", expected: max ? `≤ ${max} ms` : "within limit",
      observed: reached ? `${inc.latencyMs} ms` : "timed out", pass: reached ? (max ? (inc.latencyMs ?? 0) <= max : null) : false,
    },
  ];
  if (rpc) {
    const payloadBad = inc.reason === "BAD_PAYLOAD";
    const stale = inc.reason === "STALE_BLOCK";
    checks.push({
      id: "block", label: "Block height advancing", expected: "greater than previous probe",
      observed: !reached || inc.status !== 200 || payloadBad ? "unavailable" : `block ${inc.block}${stale ? " (frozen)" : ""}`,
      pass: !reached || inc.status !== 200 ? null : payloadBad ? false : !stale,
    });
  }
  checks.push({ id: "verdict", label: "Consensus verdict", expected: "healthy", observed: inc.ok ? "healthy" : (inc.reason ?? "failing").toLowerCase().replace(/_/g, " "), pass: inc.ok });
  return checks;
}
