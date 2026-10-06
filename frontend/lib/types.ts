export type Tone = "pulse" | "warn" | "danger" | "capital" | "muted";

export type PolicyStatus = "ACTIVE" | "BREACH_PENDING" | "PAID" | "EXPIRED" | "LAPSED";
export type ProbeMode = "rpc" | "http";
export type ProbeReason =
  | "OK"
  | "HTTP_ERROR"
  | "UNREACHABLE"
  | "HIGH_LATENCY"
  | "STALE_BLOCK"
  | "BAD_PAYLOAD";
export type IncidentKind =
  | "POLICY_CREATED"
  | "PROBE"
  | "BREACH_CONFIRMED"
  | "CLAIM_DISMISSED"
  | "PAYOUT"
  | "POLICY_EXPIRED"
  | "CLAIM_LAPSED";

export interface PoolMetrics {
  tvl: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  lockedCoverage: bigint;
  reservedPayouts: bigint;
  freeLiquidity: bigint;
  utilizationBps: number;
  apyBps: number;
  activePolicies: number;
  totalPolicies: number;
  totalPremiums: bigint;
  totalPayouts: bigint;
  totalBondForfeits: bigint;
  totalProbes: number;
  totalBreaches: number;
  activationDelay: number;
  claimGrace: number;
  probeBond: bigint;
  solvent: boolean;
}

export interface UnderwriterPosition {
  shares: bigint;
  value: bigint;
  withdrawable: bigint;
}

export interface Policy {
  id: number;
  holder: string;
  endpointUrl: string;
  host: string;
  probeMode: ProbeMode;
  maxLatencyMs: number;
  minUptimeBps: number;
  probeInterval: number;
  coverage: bigint;
  premium: bigint;
  createdAt: number;
  activeFrom: number;
  expiresAt: number;
  status: PolicyStatus;
  samplesTotal: number;
  samplesOk: number;
  uptimeBps: number;
  consecutiveFailures: number;
  baselineOk: boolean;
  lastProbeAt: number;
  lastBlock: number;
  lastLatencyMs: number;
  lastReason: ProbeReason | "";
  lastOk: boolean;
  settleAt: number;
  claimCount: number;
  payout: bigint;
}

/** One validator's independent observation of the endpoint during a probe round. */
export interface ConsensusVote {
  validator: string;
  role: "leader" | "validator";
  agree: boolean;
  /** What this validator itself observed. Absent when only the vote (not the observation) is recorded. */
  reason?: ProbeReason;
  status?: number;
  latencyMs?: number;
  block?: number;
}

export interface Incident {
  index: number;
  time: number;
  policyId: number;
  kind: IncidentKind;
  detail: string;
  by: string;
  ok?: boolean;
  reason?: ProbeReason;
  status?: number;
  latencyMs?: number;
  block?: number;
  /** Present only for probes this session observed (the chain stores the leader's view, not the vote roll). */
  votes?: ConsensusVote[];
}

export interface CreatePolicyArgs {
  endpointUrl: string;
  maxLatencyMs: number;
  coverage: bigint;
  durationBlocks: number;
  minUptimeBps: number;
  probeIntervalBlocks: number;
  probeMode: ProbeMode;
}

export interface TxReceipt {
  hash: string;
  summary: string;
  votes?: ConsensusVote[];
  /** probe / settle outcome, when the transaction returned one */
  outcome?: { ok?: boolean; reason?: string; paid?: boolean; payout?: bigint; breachStaged?: boolean };
}
