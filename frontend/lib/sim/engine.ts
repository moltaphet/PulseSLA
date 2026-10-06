/**
 * In-memory port of the PulseSLA contract (contracts/uptime_sla.py) used by demo
 * mode and by the tests. Same state machine, same integer arithmetic, same error
 * codes -- only the web probe is replaced by a scriptable endpoint, and the
 * validator round by five independent simulated observations.
 */
import {
  BREACH_CONSECUTIVE, CAPS_BPS, LIMITS, quotePremium, vestedPayout,
} from "../pricing";
import type {
  ConsensusVote, CreatePolicyArgs, Incident, IncidentKind, Policy, PolicyStatus, PoolMetrics,
  ProbeReason, UnderwriterPosition,
} from "../types";
import { ATTO, BLOCK_SECONDS, BPS, YEAR_SECONDS } from "../units";
import { hostnameOf, validateEndpointUrl } from "../pricing";

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code} ${message}`);
    this.name = "ProtocolError";
  }
}
const E = {
  expected: "[EXPECTED]", params: "[INVALID_PARAMS]", liquidity: "[INSUFFICIENT_LIQUIDITY]",
  cap: "[EXPOSURE_CAP]", state: "[INVALID_STATE]", soon: "[TOO_SOON]",
} as const;

export type EndpointMode = "healthy" | "slow" | "http502" | "http504" | "frozen" | "down" | "badpayload";
export interface EndpointState {
  mode: EndpointMode;
  block: number;
  baseLatencyMs: number;
}

export interface SimConfig {
  activationDelay: number;
  claimGrace: number;
  probeBond: bigint;
}
export const DEFAULT_SIM_CONFIG: SimConfig = { activationDelay: 3600, claimGrace: 3600, probeBond: 10n ** 16n };

const BREACH_WINDOW = 30 * 86_400;
const SETTLE_WINDOW = 7 * 86_400;
const MIN_STALE_ELAPSED = 60;
const LATENCY_TOLERANCE_BPS = 2000;
const VALIDATORS = 5;

interface Observation {
  ok: boolean;
  reason: ProbeReason;
  status: number;
  latencyMs: number;
  block: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimProtocol {
  now: number;
  readonly cfg: SimConfig;
  poolAssets = 0n;
  totalShares = 0n;
  lockedCoverage = 0n;
  reservedPayouts = 0n;
  activePolicies = 0;
  runRate = 0n;
  totalPremiums = 0n;
  totalPayouts = 0n;
  totalBondForfeits = 0n;
  totalProbes = 0;
  totalBreaches = 0;
  readonly shares = new Map<string, bigint>();
  readonly hostExposure = new Map<string, bigint>();
  readonly holderExposure = new Map<string, bigint>();
  readonly policies: Policy[] = [];
  readonly incidents: Incident[] = [];
  readonly endpoints = new Map<string, EndpointState>();
  /** Wallet balances (GEN) so demo deposits / payouts visibly move money. */
  readonly balances = new Map<string, bigint>();
  readonly transfers: { to: string; amount: bigint }[] = [];
  private windowStarted = new Map<number, number>();
  private durations = new Map<number, number>();
  private rng: () => number;

  constructor(startTime: number, cfg: SimConfig = DEFAULT_SIM_CONFIG, seed = 7) {
    this.now = startTime;
    this.cfg = cfg;
    this.rng = mulberry32(seed);
  }

  // ------------------------------------------------------------------ world
  fund(addr: string, amount: bigint): void {
    this.balances.set(addr, (this.balances.get(addr) ?? 0n) + amount);
  }
  balanceOf(addr: string): bigint {
    return this.balances.get(addr) ?? 0n;
  }
  private debit(addr: string, amount: bigint): void {
    const bal = this.balanceOf(addr);
    if (bal < amount) throw new ProtocolError(E.expected, "wallet balance too low for this transaction");
    this.balances.set(addr, bal - amount);
  }
  private pay(to: string, amount: bigint): void {
    if (amount > 0n) {
      this.transfers.push({ to, amount });
      this.fund(to, amount);
    }
  }

  ensureEndpoint(host: string): EndpointState {
    let ep = this.endpoints.get(host);
    if (!ep) {
      ep = { mode: "healthy", block: 21_000_000 + Math.floor(this.rng() * 1_000_000), baseLatencyMs: 60 + Math.floor(this.rng() * 90) };
      this.endpoints.set(host, ep);
    }
    return ep;
  }

  setEndpoint(host: string, mode: EndpointMode): void {
    this.ensureEndpoint(host).mode = mode;
  }

  /** Move the clock; chains that are alive keep producing blocks. */
  advance(seconds: number): void {
    this.now += seconds;
    for (const ep of this.endpoints.values()) {
      if (ep.mode !== "frozen" && ep.mode !== "down") ep.block += Math.floor(seconds / BLOCK_SECONDS);
    }
  }

  // ------------------------------------------------------------ underwriting
  deposit(sender: string, amount: bigint): bigint {
    if (amount < LIMITS.minDeposit) throw new ProtocolError(E.params, "deposit below minimum");
    let minted: bigint;
    if (this.totalShares === 0n) minted = amount;
    else {
      if (this.poolAssets === 0n) throw new ProtocolError(E.state, "pool has no assets; deposits closed");
      minted = (amount * this.totalShares) / this.poolAssets;
    }
    if (minted === 0n) throw new ProtocolError(E.params, "deposit too small for current share price");
    this.debit(sender, amount);
    this.shares.set(sender, (this.shares.get(sender) ?? 0n) + minted);
    this.totalShares += minted;
    this.poolAssets += amount;
    return minted;
  }

  withdraw(sender: string, amount: bigint): bigint {
    if (amount <= 0n) throw new ProtocolError(E.params, "amount must be positive");
    const held = this.shares.get(sender) ?? 0n;
    if (held === 0n || this.totalShares === 0n) throw new ProtocolError(E.liquidity, "no underwriting position");
    const value = (held * this.poolAssets) / this.totalShares;
    if (amount > value) throw new ProtocolError(E.liquidity, "amount exceeds position value");
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    if (amount > free) throw new ProtocolError(E.liquidity, "capital is locked behind active coverage");
    let burn = (amount * this.totalShares + this.poolAssets - 1n) / this.poolAssets;
    if (burn > held) burn = held;
    this.shares.set(sender, held - burn);
    this.totalShares -= burn;
    this.poolAssets -= amount;
    this.pay(sender, amount);
    return amount;
  }

  underwriter(addr: string): UnderwriterPosition {
    const s = this.shares.get(addr) ?? 0n;
    const value = this.totalShares > 0n ? (s * this.poolAssets) / this.totalShares : 0n;
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    return { shares: s, value, withdrawable: value < free ? value : free };
  }

  // ---------------------------------------------------------------- policies
  quote(coverage: bigint, durationBlocks: number, uptimeBps: number): bigint {
    return quotePremium(coverage, durationBlocks, uptimeBps);
  }

  createPolicy(sender: string, a: CreatePolicyArgs, value: bigint): number {
    if (validateEndpointUrl(a.endpointUrl) !== null) throw new ProtocolError(E.params, "endpoint URL rejected (must be a public http(s) host)");
    if (a.maxLatencyMs < LIMITS.minLatencyMs || a.maxLatencyMs > LIMITS.maxLatencyMs) throw new ProtocolError(E.params, "max_latency_ms out of range");
    if (a.coverage < LIMITS.minCoverage) throw new ProtocolError(E.params, "coverage below minimum");
    if (a.durationBlocks < LIMITS.minDurationBlocks || a.durationBlocks > LIMITS.maxDurationBlocks) throw new ProtocolError(E.params, "duration out of range");
    if (a.minUptimeBps < LIMITS.minUptimeBps || a.minUptimeBps > LIMITS.maxUptimeBps) throw new ProtocolError(E.params, "min_uptime_bps out of range");
    if (a.probeIntervalBlocks < LIMITS.minIntervalBlocks || a.probeIntervalBlocks > LIMITS.maxIntervalBlocks) throw new ProtocolError(E.params, "probe interval out of range");
    const premium = quotePremium(a.coverage, a.durationBlocks, a.minUptimeBps);
    if (value < premium) throw new ProtocolError(E.expected, `premium ${premium} not covered by value ${value}`);

    const host = hostnameOf(a.endpointUrl);
    const hostNow = this.hostExposure.get(host) ?? 0n;
    const holderNow = this.holderExposure.get(sender) ?? 0n;
    if (a.coverage > (this.poolAssets * CAPS_BPS.policy) / BPS) throw new ProtocolError(E.cap, "coverage exceeds per-policy cap of pool depth");
    if (this.lockedCoverage + a.coverage > (this.poolAssets * CAPS_BPS.utilization) / BPS) throw new ProtocolError(E.cap, "pool utilization cap reached");
    if (hostNow + a.coverage > (this.poolAssets * CAPS_BPS.host) / BPS) throw new ProtocolError(E.cap, "per-endpoint exposure cap reached");
    if (holderNow + a.coverage > (this.poolAssets * CAPS_BPS.holder) / BPS) throw new ProtocolError(E.cap, "per-holder exposure cap reached");

    this.debit(sender, value);
    const durationSecs = a.durationBlocks * BLOCK_SECONDS;
    const id = this.policies.length + 1;
    const activeFrom = this.now + this.cfg.activationDelay;
    this.policies.push({
      id, holder: sender, endpointUrl: a.endpointUrl, host, probeMode: a.probeMode,
      maxLatencyMs: a.maxLatencyMs, minUptimeBps: a.minUptimeBps, probeInterval: a.probeIntervalBlocks * BLOCK_SECONDS,
      coverage: a.coverage, premium, createdAt: this.now, activeFrom, expiresAt: activeFrom + durationSecs,
      status: "ACTIVE", samplesTotal: 0, samplesOk: 0, uptimeBps: 10_000, consecutiveFailures: 0, baselineOk: false,
      lastProbeAt: 0, lastBlock: 0, lastLatencyMs: 0, lastReason: "", lastOk: false, settleAt: 0, claimCount: 0, payout: 0n,
    });
    this.durations.set(id, durationSecs);
    this.lockedCoverage += a.coverage;
    this.hostExposure.set(host, hostNow + a.coverage);
    this.holderExposure.set(sender, holderNow + a.coverage);
    this.activePolicies += 1;
    this.runRate += (premium * BigInt(YEAR_SECONDS)) / BigInt(durationSecs);
    this.poolAssets += premium;
    this.totalPremiums += premium;
    this.log(id, "POLICY_CREATED", sender, `coverage ${a.coverage}, premium ${premium}, ${a.minUptimeBps} bps uptime, ${a.maxLatencyMs}ms limit`);
    this.pay(sender, value - premium); // overpayment is refunded
    return id;
  }

  get(id: number): Policy {
    const p = this.policies[id - 1];
    if (!p) throw new ProtocolError(E.state, "unknown policy");
    return p;
  }

  expirePolicy(id: number): PolicyStatus {
    const p = this.get(id);
    if (p.status === "ACTIVE" && this.now >= p.expiresAt) {
      this.close(id, "EXPIRED");
      this.log(id, "POLICY_EXPIRED", "", "term ended with no confirmed breach");
      return "EXPIRED";
    }
    if (p.status === "BREACH_PENDING" && this.now > p.settleAt + SETTLE_WINDOW) {
      this.close(id, "LAPSED");
      this.log(id, "CLAIM_LAPSED", "", "staged claim not settled within the settlement window");
      return "LAPSED";
    }
    throw new ProtocolError(E.state, "policy cannot be expired yet");
  }

  // ------------------------------------------------------------------ probes
  /** One validator's independent look at the endpoint. */
  private measure(p: Policy, jitter: boolean): Observation {
    const ep = this.ensureEndpoint(p.host);
    const j = (v: number, pct: number) => (jitter ? Math.round(v * (1 + (this.rng() - 0.5) * 2 * pct)) : v);
    let status = 200;
    let latency = j(ep.baseLatencyMs, 0.12);
    let block = ep.block + (jitter ? Math.floor(this.rng() * 2) : 0);
    let reachable = true;
    let payloadOk = true;
    switch (ep.mode) {
      case "slow": latency = j(p.maxLatencyMs * 3, 0.1); break;
      case "http502": status = 502; latency = j(45, 0.2); break;
      case "http504": status = 504; latency = j(p.maxLatencyMs * 6, 0.05); break;
      case "down": reachable = false; latency = j(p.maxLatencyMs * 6, 0.05); break;
      case "badpayload": payloadOk = false; break;
      default: break;
    }
    const elapsed = p.lastProbeAt > 0 ? this.now - p.lastProbeAt : 0;
    let reason: ProbeReason;
    if (!reachable) reason = "UNREACHABLE";
    else if (status !== 200) reason = "HTTP_ERROR";
    else if (p.probeMode === "rpc" && !payloadOk) reason = "BAD_PAYLOAD";
    else if (latency > p.maxLatencyMs) reason = "HIGH_LATENCY";
    else if (p.probeMode === "rpc" && p.lastBlock > 0 && elapsed >= MIN_STALE_ELAPSED && block <= p.lastBlock) reason = "STALE_BLOCK";
    else reason = "OK";
    if (p.probeMode === "http" || !reachable || status !== 200 || !payloadOk) block = -1;
    return { ok: reason === "OK", reason, status: reachable ? status : 0, latencyMs: Math.max(0, latency), block };
  }

  private agree(lead: Observation, mine: Observation, maxLatency: number): boolean {
    if (lead.ok && lead.status !== 200) return false;
    if (lead.ok === mine.ok) return true;
    const lat = (r: ProbeReason) => r === "OK" || r === "HIGH_LATENCY";
    if (lat(lead.reason) && lat(mine.reason)) {
      const lo = Math.floor((maxLatency * (10_000 - LATENCY_TOLERANCE_BPS)) / 10_000);
      const hi = Math.floor((maxLatency * (10_000 + LATENCY_TOLERANCE_BPS)) / 10_000);
      return lead.latencyMs >= lo && lead.latencyMs <= hi && mine.latencyMs >= lo && mine.latencyMs <= hi;
    }
    return false;
  }

  /** Leader + validators observe independently; the leader's verdict stands only if the quorum agrees. */
  private consensus(p: Policy): { leader: Observation; votes: ConsensusVote[] } {
    const leader = this.measure(p, true);
    const votes: ConsensusVote[] = [
      { validator: "validator-1", role: "leader", agree: true, reason: leader.reason, status: leader.status, latencyMs: leader.latencyMs, block: leader.block },
    ];
    for (let i = 2; i <= VALIDATORS; i++) {
      const mine = this.measure(p, true);
      votes.push({ validator: `validator-${i}`, role: "validator", agree: this.agree(leader, mine, p.maxLatencyMs), reason: mine.reason, status: mine.status, latencyMs: mine.latencyMs, block: mine.block });
    }
    const agreeing = votes.filter((v) => v.agree).length;
    if (agreeing * 2 <= VALIDATORS) throw new ProtocolError("[NO_CONSENSUS]", "validators rejected the leader's observation; retry");
    return { leader, votes };
  }

  private uptime(p: Policy): number {
    return p.samplesTotal === 0 ? 10_000 : Math.floor((p.samplesOk * 10_000) / p.samplesTotal);
  }

  private describe(o: Observation, maxLatency: number): string {
    switch (o.reason) {
      case "OK": return `healthy: HTTP 200 in ${o.latencyMs}ms, block ${o.block}`;
      case "UNREACHABLE": return "endpoint unreachable (connection failed or timed out)";
      case "HTTP_ERROR": return `HTTP ${o.status} returned, SLA requires 200`;
      case "BAD_PAYLOAD": return "eth_blockNumber returned an invalid or missing result";
      case "HIGH_LATENCY": return `latency ${o.latencyMs}ms exceeds limit ${maxLatency}ms`;
      default: return `block height frozen at ${o.block}: node is not advancing`;
    }
  }

  triggerProbe(sender: string, id: number, bond: bigint) {
    const p = this.get(id);
    if (p.status !== "ACTIVE") throw new ProtocolError(E.state, "policy is not ACTIVE");
    if (this.now < p.activeFrom) throw new ProtocolError(E.soon, "policy is still in its activation delay");
    if (this.now >= p.expiresAt) throw new ProtocolError(E.state, "policy term has ended");
    if (p.lastProbeAt > 0 && this.now < p.lastProbeAt + p.probeInterval) throw new ProtocolError(E.soon, "probe interval has not elapsed");
    if (bond < this.cfg.probeBond) throw new ProtocolError(E.expected, `probe bond ${this.cfg.probeBond} required`);
    this.debit(sender, bond);
    const { leader: obs, votes } = this.consensus(p);

    const ws = this.windowStarted.get(id) ?? 0;
    if (ws === 0 || this.now - ws >= BREACH_WINDOW) {
      this.windowStarted.set(id, this.now);
      p.samplesTotal = 0;
      p.samplesOk = 0;
    }
    p.samplesTotal += 1;
    this.totalProbes += 1;
    p.lastProbeAt = this.now;
    p.lastLatencyMs = obs.latencyMs;
    p.lastReason = obs.reason;
    p.lastOk = obs.ok;
    if (obs.ok) {
      p.samplesOk += 1;
      p.consecutiveFailures = 0;
      p.baselineOk = true;
    } else p.consecutiveFailures += 1;
    if (obs.block > 0 && (obs.reason === "OK" || obs.reason === "HIGH_LATENCY")) p.lastBlock = obs.block;
    p.uptimeBps = this.uptime(p);
    this.log(id, "PROBE", sender, this.describe(obs, p.maxLatencyMs), obs, votes);

    let forfeit = 0n;
    if (obs.ok) {
      forfeit = this.cfg.probeBond;
      this.poolAssets += forfeit;
      this.totalBondForfeits += forfeit;
    }
    const staged = this.maybeStage(id, p);
    this.pay(sender, bond - forfeit);
    return { ...obs, votes, breachStaged: staged, consecutiveFailures: p.consecutiveFailures, uptimeBps: p.uptimeBps };
  }

  private maybeStage(id: number, p: Policy): boolean {
    if (p.consecutiveFailures < BREACH_CONSECUTIVE || !p.baselineOk) return false;
    if (this.uptime(p) >= p.minUptimeBps) return false;
    p.status = "BREACH_PENDING";
    p.settleAt = this.now + this.cfg.claimGrace;
    p.claimCount += 1;
    this.reservedPayouts += p.coverage;
    this.totalBreaches += 1;
    this.log(id, "BREACH_CONFIRMED", "", `${p.consecutiveFailures} consecutive failures; uptime ${this.uptime(p)} bps < ${p.minUptimeBps} bps SLA; payout reserved, grace until ${p.settleAt}`);
    return true;
  }

  settleClaim(sender: string, id: number, bond: bigint) {
    const p = this.get(id);
    if (p.status !== "BREACH_PENDING") throw new ProtocolError(E.state, "no staged claim on this policy");
    if (this.now < p.settleAt) throw new ProtocolError(E.soon, "claim grace period has not elapsed");
    if (this.now > p.settleAt + SETTLE_WINDOW) throw new ProtocolError(E.state, "claim lapsed; call expire_policy");
    if (bond < this.cfg.probeBond) throw new ProtocolError(E.expected, `probe bond ${this.cfg.probeBond} required`);
    this.debit(sender, bond);
    const { leader: obs, votes } = this.consensus(p);
    this.totalProbes += 1;
    const text = this.describe(obs, p.maxLatencyMs);
    if (!obs.ok) {
      let payout = vestedPayout(p.coverage, this.now - p.activeFrom);
      if (payout > this.poolAssets) payout = this.poolAssets;
      p.payout = payout;
      p.lastReason = obs.reason;
      p.lastOk = false;
      p.lastProbeAt = this.now;
      p.lastLatencyMs = obs.latencyMs;
      this.close(id, "PAID");
      this.poolAssets -= payout;
      this.totalPayouts += payout;
      this.log(id, "PAYOUT", sender, `re-verification confirmed breach (${text}); paid ${payout} of ${p.coverage} coverage`, obs, votes);
      this.pay(p.holder, payout);
      this.pay(sender, bond);
      return { paid: true, payout, reason: obs.reason, votes };
    }
    const forfeit = this.cfg.probeBond;
    this.poolAssets += forfeit;
    this.totalBondForfeits += forfeit;
    this.reservedPayouts -= p.coverage;
    p.status = "ACTIVE";
    p.consecutiveFailures = 0;
    p.lastOk = true;
    p.lastReason = "OK";
    p.lastProbeAt = this.now;
    p.lastLatencyMs = obs.latencyMs;
    if (obs.block > 0) p.lastBlock = obs.block;
    this.log(id, "CLAIM_DISMISSED", sender, `endpoint recovered during grace period (${text})`, obs, votes);
    this.pay(sender, bond - forfeit);
    return { paid: false, payout: 0n, reason: "OK" as ProbeReason, votes };
  }

  private close(id: number, status: PolicyStatus): void {
    const p = this.get(id);
    if (p.status === "BREACH_PENDING") this.reservedPayouts -= p.coverage;
    this.lockedCoverage -= p.coverage;
    this.hostExposure.set(p.host, (this.hostExposure.get(p.host) ?? 0n) - p.coverage);
    this.holderExposure.set(p.holder, (this.holderExposure.get(p.holder) ?? 0n) - p.coverage);
    this.activePolicies -= 1;
    this.runRate -= (p.premium * BigInt(YEAR_SECONDS)) / BigInt(this.durations.get(id) ?? 1);
    p.status = status;
  }

  private log(policyId: number, kind: IncidentKind, by: string, detail: string, obs?: Observation, votes?: ConsensusVote[]): void {
    const inc: Incident = { index: this.incidents.length, time: this.now, policyId, kind, detail, by };
    if (obs) {
      inc.ok = obs.ok; inc.reason = obs.reason; inc.status = obs.status; inc.latencyMs = obs.latencyMs; inc.block = obs.block;
    }
    if (votes) inc.votes = votes;
    this.incidents.push(inc);
  }

  // ------------------------------------------------------------------- views
  metrics(): PoolMetrics {
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    return {
      tvl: this.poolAssets,
      totalShares: this.totalShares,
      sharePrice: this.totalShares > 0n ? (this.poolAssets * ATTO) / this.totalShares : ATTO,
      lockedCoverage: this.lockedCoverage,
      reservedPayouts: this.reservedPayouts,
      freeLiquidity: free,
      utilizationBps: this.poolAssets > 0n ? Number((this.lockedCoverage * BPS) / this.poolAssets) : 0,
      apyBps: this.poolAssets > 0n ? Number((this.runRate * BPS) / this.poolAssets) : 0,
      activePolicies: this.activePolicies,
      totalPolicies: this.policies.length,
      totalPremiums: this.totalPremiums,
      totalPayouts: this.totalPayouts,
      totalBondForfeits: this.totalBondForfeits,
      totalProbes: this.totalProbes,
      totalBreaches: this.totalBreaches,
      activationDelay: this.cfg.activationDelay,
      claimGrace: this.cfg.claimGrace,
      probeBond: this.cfg.probeBond,
      solvent: this.lockedCoverage <= this.poolAssets && this.reservedPayouts <= this.lockedCoverage,
    };
  }
}
