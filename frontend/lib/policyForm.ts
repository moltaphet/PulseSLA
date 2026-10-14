import {
  coverageLimits, exposureFor, LIMITS, MIN_REFERENCES, minDurationBlocks, quotePremium, rateBpsFor, SLA_TIERS, referencesFor,
  type CapName, type CoverageLimits,
} from "./pricing";
import type { CreatePolicyArgs, Endpoint, Policy } from "./types";
import { BLOCK_SECONDS, daysToBlocks, formatGen, parseGen, formatDuration } from "./units";

export interface PolicyFormState {
  /** Registry id of the endpoint to insure. There is deliberately no URL field. */
  endpointId: string;
  tier: (typeof SLA_TIERS)[number]["id"];
  coverage: string;
  days: string;
  intervalMinutes: string;
}

export const DEFAULT_FORM: PolicyFormState = {
  endpointId: "", tier: "gold", coverage: "", days: "30", intervalMinutes: "5",
};

export interface FormContext {
  tvl: bigint;
  lockedCoverage: bigint;
  policies: readonly Policy[];
  holder: string | null;
  balance: bigint | null;
  /** The authenticated registry, and the current time (unix seconds) for its listing delay. */
  endpoints: readonly Endpoint[];
  now: number;
  /** Claim grace period in seconds (a deployment parameter); needed for the minimum insurable term. */
  claimGrace?: number;
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
  host: "the per-provider cap (20% of pool depth across all of a provider's domains)",
  holder: "your per-holder cap (20% of pool depth)",
};

export type Insurability =
  | { state: "insurable" }
  | { state: "activating"; at: number }
  | { state: "delisted" }
  | { state: "no-references"; have: number };

/** Why an endpoint can or cannot be insured right now (mirrors the checks at the top of `create_policy`). */
export function insurability(e: Endpoint, all: readonly Endpoint[], now: number): Insurability {
  if (e.status !== "LISTED") return { state: "delisted" };
  if (now < e.insurableFrom) return { state: "activating", at: e.insurableFrom };
  const have = referencesFor(e, all, now).length;
  if (have < MIN_REFERENCES) return { state: "no-references", have };
  return { state: "insurable" };
}

function endpointProblem(e: Endpoint | undefined, all: readonly Endpoint[], now: number): string | null {
  if (!e) return "Choose an endpoint from the authenticated registry";
  const i = insurability(e, all, now);
  switch (i.state) {
    case "delisted": return "This endpoint has been delisted";
    case "activating": return "This listing is still inside its 24 h authentication delay";
    case "no-references": return `Only ${i.have} independent reference providers are listed on this chain (${MIN_REFERENCES} required)`;
    default: return null;
  }
}

function int(s: string): number | null {
  return /^\d+$/.test(s.trim()) ? Number(s.trim()) : null;
}

/** Validate the form against the contract's rules and compute the quote. Never throws. */
export function draftPolicy(form: PolicyFormState, ctx: FormContext): PolicyDraft {
  const errors: FormErrors = {};
  const tier = SLA_TIERS.find((t) => t.id === form.tier) ?? SLA_TIERS[0];

  const endpoint = ctx.endpoints.find((e) => e.id === form.endpointId);
  const endpointError = endpointProblem(endpoint, ctx.endpoints, ctx.now);
  if (form.endpointId === "") errors.endpointId = undefined;
  else if (endpointError) errors.endpointId = endpointError;
  const endpointOk = endpoint !== undefined && endpointError === null;

  const days = Number(form.days);
  const blocks = Number.isFinite(days) && form.days.trim() !== "" ? daysToBlocks(days) : NaN;
  if (!(blocks >= LIMITS.minDurationBlocks && blocks <= LIMITS.maxDurationBlocks)) errors.days = "Duration must be between 1 hour and 365 days";

  const minutes = int(form.intervalMinutes);
  const intervalBlocks = minutes === null ? NaN : minutes * 5;
  if (!(intervalBlocks >= LIMITS.minIntervalBlocks && intervalBlocks <= LIMITS.maxIntervalBlocks)) errors.intervalMinutes = "Probe interval must be 1–30 minutes";

  // A term the chosen SLA and cadence cannot possibly pay out on is refused before any premium is taken.
  if (ctx.claimGrace !== undefined && !errors.days && !errors.intervalMinutes && Number.isFinite(blocks)) {
    const need = minDurationBlocks(tier.uptimeBps, intervalBlocks, ctx.claimGrace);
    if (blocks < need) {
      errors.days = `Too short for a ${tier.uptimeLabel} SLA probed every ${minutes} min: at least ${formatDuration(need * BLOCK_SECONDS)} is needed for a claim to be possible`;
    }
  }

  const exposure = endpointOk ? exposureFor(ctx.policies, endpoint.host, ctx.holder ?? "") : { host: 0n, holder: 0n };
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
  const valid = endpointOk && Object.keys(clean).length === 0 && coverage !== null && premium !== null;
  return {
    args: valid
      ? {
          endpointId: form.endpointId, coverage: coverage!, durationBlocks: blocks,
          minUptimeBps: tier.uptimeBps, probeIntervalBlocks: intervalBlocks,
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
