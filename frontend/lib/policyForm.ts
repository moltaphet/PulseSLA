import {
  coverageLimits, exposureFor, hostnameOf, LIMITS, quotePremium, rateBpsFor, SLA_TIERS, validateEndpointUrl,
  type CapName, type CoverageLimits,
} from "./pricing";
import type { CreatePolicyArgs, Policy, ProbeMode } from "./types";
import { daysToBlocks, formatGen, parseGen, formatDuration } from "./units";

export interface PolicyFormState {
  url: string;
  mode: ProbeMode;
  tier: (typeof SLA_TIERS)[number]["id"];
  maxLatencyMs: string;
  coverage: string;
  days: string;
  intervalMinutes: string;
}

export const DEFAULT_FORM: PolicyFormState = {
  url: "", mode: "rpc", tier: "gold", maxLatencyMs: "500", coverage: "", days: "30", intervalMinutes: "5",
};

export interface FormContext {
  tvl: bigint;
  lockedCoverage: bigint;
  policies: readonly Policy[];
  holder: string | null;
  balance: bigint | null;
}

export type FormErrors = Partial<Record<keyof PolicyFormState, string>>;

export interface PolicyDraft {
  args: CreatePolicyArgs | null;
  premium: bigint | null;
  /** Premium as bps of coverage for the whole term. */
  premiumBps: number | null;
  annualRateBps: number;
  limits: CoverageLimits | null;
  errors: FormErrors;
  valid: boolean;
}

const CAP_TEXT: Record<CapName, string> = {
  policy: "the per-policy cap (10% of pool depth)",
  utilization: "the pool utilization cap (80%)",
  host: "the per-domain cap (20% of pool depth across all subdomains)",
  holder: "your per-holder cap (20% of pool depth)",
};

function int(s: string): number | null {
  return /^\d+$/.test(s.trim()) ? Number(s.trim()) : null;
}

/** Validate the form against the contract's rules and compute the quote. Never throws. */
export function draftPolicy(form: PolicyFormState, ctx: FormContext): PolicyDraft {
  const errors: FormErrors = {};
  const tier = SLA_TIERS.find((t) => t.id === form.tier) ?? SLA_TIERS[0];

  const urlError = form.url === "" ? null : validateEndpointUrl(form.url.trim() === form.url ? form.url : form.url);
  if (form.url === "") errors.url = undefined;
  else if (urlError) errors.url = urlError;
  const urlOk = form.url !== "" && urlError === null;

  const latency = int(form.maxLatencyMs);
  if (latency === null || latency < LIMITS.minLatencyMs || latency > LIMITS.maxLatencyMs) {
    errors.maxLatencyMs = `Enter ${LIMITS.minLatencyMs}–${LIMITS.maxLatencyMs.toLocaleString("en-US")} ms`;
  }

  const days = Number(form.days);
  const blocks = Number.isFinite(days) && form.days.trim() !== "" ? daysToBlocks(days) : NaN;
  if (!(blocks >= LIMITS.minDurationBlocks && blocks <= LIMITS.maxDurationBlocks)) errors.days = "Duration must be between 1 hour and 365 days";

  const minutes = int(form.intervalMinutes);
  const intervalBlocks = minutes === null ? NaN : minutes * 5;
  if (!(intervalBlocks >= LIMITS.minIntervalBlocks && intervalBlocks <= LIMITS.maxIntervalBlocks)) errors.intervalMinutes = "Probe interval must be 1–1440 minutes";

  const host = urlOk ? hostnameOf(form.url) : "";
  const exposure = host ? exposureFor(ctx.policies, host, ctx.holder ?? "") : { host: 0n, holder: 0n };
  const limits = ctx.tvl > 0n
    ? coverageLimits({ tvl: ctx.tvl, lockedCoverage: ctx.lockedCoverage, hostExposure: exposure.host, holderExposure: exposure.holder })
    : null;

  const coverage = form.coverage.trim() === "" ? null : parseGen(form.coverage);
  if (form.coverage.trim() !== "") {
    if (coverage === null || coverage === 0n) errors.coverage = "Enter a valid coverage amount";
    else if (coverage < LIMITS.minCoverage) errors.coverage = `Minimum coverage is ${formatGen(LIMITS.minCoverage, 3)} GEN`;
    else if (limits && coverage > limits.max) {
      errors.coverage = limits.max === 0n
        ? `The pool has no capacity left under ${CAP_TEXT[limits.binding]}`
        : `The pool can underwrite at most ${formatGen(limits.max)} GEN here, limited by ${CAP_TEXT[limits.binding]}`;
    }
  }

  const ready = coverage !== null && coverage >= LIMITS.minCoverage && !errors.days && !Number.isNaN(blocks);
  const premium = ready ? quotePremium(coverage, blocks, tier.uptimeBps) : null;
  if (premium !== null && ctx.balance !== null && premium > ctx.balance) errors.coverage ??= "Your wallet balance cannot cover the premium";

  const clean = Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as FormErrors;
  const valid = urlOk && Object.keys(clean).length === 0 && coverage !== null && premium !== null && latency !== null;
  return {
    args: valid
      ? {
          endpointUrl: form.url, maxLatencyMs: latency!, coverage: coverage!, durationBlocks: blocks,
          minUptimeBps: tier.uptimeBps, probeIntervalBlocks: intervalBlocks, probeMode: form.mode,
        }
      : null,
    premium,
    premiumBps: premium !== null && coverage ? Number((premium * 10_000n) / coverage) : null,
    annualRateBps: Number(rateBpsFor(tier.uptimeBps)),
    limits,
    errors: clean,
    valid,
  };
}

export function describeTerm(days: number): string {
  return formatDuration(days * 86_400);
}
