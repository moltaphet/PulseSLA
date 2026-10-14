export type Tone = "pulse" | "warn" | "danger" | "capital" | "muted";

/** VESTING: breach confirmed, payout streaming out after its cooldown. PAID: fully released. */
export type PolicyStatus = "ACTIVE" | "BREACH_PENDING" | "VESTING" | "PAID" | "EXPIRED" | "LAPSED";
export type EndpointStatus = "LISTED" | "DELISTED";
/** Corroborated verdict of one probe round. INCONCLUSIVE rounds change nothing. */
export type Verdict = "HEALTHY" | "FAILING" | "INCONCLUSIVE";
export type ProbeReason =
  | "OK"
  | "HTTP_ERROR"
  | "UNREACHABLE"
  | "STALE_BLOCK"
  | "BAD_PAYLOAD"
  | "RATE_LIMITED"
  | "NO_BASELINE";
export type IncidentKind =
  | "POLICY_CREATED"
  | "PROBE"
  | "BREACH_STAGED"
  | "BREACH_CONFIRMED_VESTING"
  | "CLAIM_DISMISSED"
  | "PAYOUT_RELEASED"
  | "POLICY_EXPIRED"
  | "CLAIM_LAPSED"
  | "ENDPOINT_LISTED"
  | "ENDPOINT_DELISTED"
  | "GOVERNOR_CHANGED";

/** A governor-listed, on-chain-authenticated provider endpoint: the only thing a policy can insure. */
export interface Endpoint {
  id: string;
  provider: string;
  /** Registrable domain the URL must live under (bound by the attestation hash). */
  domain: string;
  url: string;
  host: string;
  apex: string;
  chainId: number;
  attestation: string;
  listedAt: number;
  /** Unix seconds after which the listing is insurable and counts as a reference. */
  insurableFrom: number;
  status: EndpointStatus;
}

export interface PoolMetrics {
  tvl: bigint;
  /** Pool assets minus capital reserved for staged claims: the basis for share pricing and redemptions. */
  netAssets: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  lockedCoverage: bigint;
  reservedPayouts: bigint;
  /** Confirmed payouts not yet released to holders (a subset of reservedPayouts). */
  owedPayouts: bigint;
  /** Payouts reserved for claims that are staged but not yet confirmed. */
  stagedClaims: bigint;
  listedEndpoints: number;
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
  /** Claim-velocity window: payouts so far this epoch, and the epoch ceiling. */
  epochPaid: bigint;
  epochCeiling: bigint;
  maxEpochPayoutBps: number;
}

export interface UnderwriterPosition {
  shares: bigint;
  value: bigint;
  withdrawable: bigint;
}

export interface Policy {
  id: number;
  holder: string;
  endpointId: string;
  endpointUrl: string;
  host: string;
  /** Registrable domain (eTLD+1): the unit of the per-provider exposure cap. */
  apex: string;
  chainId: number;
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
  inconclusiveRounds: number;
  downtimeSecs: number;
  consecutiveFailures: number;
  /** Block-clock time the current failing streak began (0 when not failing). */
  outageStartedAt: number;
  /** Reference-chain blocks that have elapsed during the current failing streak. */
  outageBlocks: number;
  baselineOk: boolean;
  lastProbeAt: number;
  lastBlock: number;
  lastRefHead: number;
  lastReason: ProbeReason | "";
  lastOk: boolean;
  /** When the current/last claim was staged: the payout age-ramp is frozen here, never at settlement. */
  breachAt: number;
  settleAt: number;
  claimCount: number;
  /** Confirmed payout (fixed at confirmation), the part already released, and the part releasable now. */
  payout: bigint;
  released: bigint;
  releasable: bigint;
  vestStart: number;
}

/** One validator's independent observation of the endpoint during a probe round. */
export interface ConsensusVote {
  validator: string;
  role: "leader" | "validator";
  agree: boolean;
  /** What this validator itself observed. Absent when only the vote (not the observation) is recorded. */
  verdict?: Verdict;
  reason?: ProbeReason;
  status?: number;
  block?: number;
  refHead?: number;
  refsOk?: number;
}

export interface Incident {
  index: number;
  time: number;
  policyId: number;
  kind: IncidentKind;
  detail: string;
  by: string;
  ok?: boolean;
  verdict?: Verdict;
  reason?: ProbeReason;
  status?: number;
  block?: number;
  /** Lower-median head of the healthy reference providers this round, and how many of them answered. */
  refHead?: number;
  refsOk?: number;
  refsTotal?: number;
  /** Present only for probes this session observed (the chain stores the leader's view, not the vote roll). */
  votes?: ConsensusVote[];
}

export interface CreatePolicyArgs {
  /** A registry id: policies never take a URL. */
  endpointId: string;
  coverage: bigint;
  durationBlocks: number;
  minUptimeBps: number;
  probeIntervalBlocks: number;
}

export interface TxReceipt {
  hash: string;
  summary: string;
  votes?: ConsensusVote[];
  /** probe / settle outcome, when the transaction returned one */
  outcome?: { ok?: boolean; verdict?: Verdict; reason?: string; confirmed?: boolean; payout?: bigint; breachStaged?: boolean; released?: bigint };
}
