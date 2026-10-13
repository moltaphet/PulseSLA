/**
 * In-memory port of the PulseSLA contract (contracts/uptime_sla.py) used by demo
 * mode and by the tests. Same state machine, same integer arithmetic, same error
 * codes. Only the web layer is replaced: each host is a scriptable simulated
 * endpoint, and the validator round by five independent simulated observations
 * of the target AND its reference providers.
 */
import {
  apexOf, BREACH_CONSECUTIVE, CAPS_BPS, EPOCH_SECONDS, LIMITS, LISTING_DELAY_SECS, MAX_BLOCK_DRIFT, MAX_EPOCH_PAYOUT_BPS,
  MAX_LAG_BLOCKS, MAX_REFERENCES, MEASUREMENT_WINDOW_SECS, MIN_OUTAGE_BLOCKS, MIN_OUTAGE_SECS, MIN_REFERENCES,
  MIN_UPTIME_WINDOW_SECS, PAYOUT_COOLDOWN_SECS, PAYOUT_VEST_SECS, quotePremium, releasableBy, SETTLE_WINDOW_SECONDS,
  validateEndpointUrl, vestedPayout, hostnameOf,
} from "../pricing";
import type {
  ConsensusVote, CreatePolicyArgs, Endpoint, Incident, IncidentKind, Policy, PolicyStatus, PoolMetrics,
  ProbeReason, UnderwriterPosition, Verdict,
} from "../types";
import { ATTO, BLOCK_SECONDS, BPS, YEAR_SECONDS } from "../units";

export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code} ${message}`);
    this.name = "ProtocolError";
  }
}
const E = {
  velocity: "[VELOCITY_LIMIT]", frozen: "[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]", expected: "[EXPECTED]", params: "[INVALID_PARAMS]",
  liquidity: "[INSUFFICIENT_LIQUIDITY]", cap: "[EXPOSURE_CAP]", state: "[INVALID_STATE]", soon: "[TOO_SOON]",
  unauth: "[UNAUTHENTICATED_ENDPOINT]", registry: "[REGISTRY_REJECTED]", unauthorized: "[UNAUTHORIZED]", inconclusive: "[INCONCLUSIVE]",
} as const;

export type EndpointMode = "healthy" | "http502" | "http504" | "ratelimited" | "frozen" | "down" | "badpayload";
export interface EndpointState {
  mode: EndpointMode;
  block: number;
  /** Chain this host actually serves; registration authenticates the declared chain id against it. */
  chainId: number;
}

export interface SimConfig {
  activationDelay: number;
  claimGrace: number;
  probeBond: bigint;
}
export const DEFAULT_SIM_CONFIG: SimConfig = { activationDelay: 3600, claimGrace: 3600, probeBond: 10n ** 16n };

const SETTLE_WINDOW = SETTLE_WINDOW_SECONDS;
const VALIDATORS = 5;
const MAX_ENDPOINTS = 32;
const MAX_BLOCK_AHEAD = 2;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

interface Observation {
  ok: boolean;
  reason: ProbeReason;
  status: number;
  block: number;
}

/** One corroborated round: the verdict plus what it was corroborated against. */
export interface Round {
  verdict: Verdict;
  reason: ProbeReason;
  status: number;
  block: number;
  refHead: number;
  refsOk: number;
  refsTotal: number;
  refIds: string[];
  /** Per-reference health, in reference order (not part of the contract's return value). */
  refs: { id: string; ok: boolean; block: number }[];
}

export interface RegisterSpec {
  id: string;
  provider: string;
  domain: string;
  chainId: number;
  url: string;
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

/**
 * Deterministic round verdict from raw observations. Mirror of `_classify`:
 * the reference quorum is the baseline; the head is the LOWER median of healthy
 * reference heights; a rate-limited target is inconclusive.
 */
export function classify(t: Observation, refs: { ok: boolean; block: number }[], nRefs: number): Pick<Round, "verdict" | "reason" | "refHead" | "refsOk"> {
  const healthy = refs.filter((r) => r.ok && r.block > 0).map((r) => r.block).sort((a, b) => a - b);
  const quorum = Math.floor(nRefs / 2) + 1;
  if (nRefs < MIN_REFERENCES || healthy.length < quorum) return { verdict: "INCONCLUSIVE", reason: "NO_BASELINE", refHead: -1, refsOk: healthy.length };
  const head = healthy[Math.floor((healthy.length - 1) / 2)];
  if (t.ok) {
    if (t.block + MAX_LAG_BLOCKS < head) return { verdict: "FAILING", reason: "STALE_BLOCK", refHead: head, refsOk: healthy.length };
    return { verdict: "HEALTHY", reason: "OK", refHead: head, refsOk: healthy.length };
  }
  if (t.reason === "RATE_LIMITED") return { verdict: "INCONCLUSIVE", reason: "RATE_LIMITED", refHead: head, refsOk: healthy.length };
  return { verdict: "FAILING", reason: t.reason, refHead: head, refsOk: healthy.length };
}

export class SimProtocol {
  now: number;
  readonly cfg: SimConfig;
  /** The registry governor: the only account that may list or delist endpoints, and it cannot hold policies. */
  readonly governor: string;
  poolAssets = 0n;
  totalShares = 0n;
  lockedCoverage = 0n;
  reservedPayouts = 0n;
  owedPayouts = 0n;
  activePolicies = 0;
  runRate = 0n;
  totalPremiums = 0n;
  totalPayouts = 0n;
  totalBondForfeits = 0n;
  totalProbes = 0;
  totalBreaches = 0;
  velocityEpoch = 0;
  velocityPaid = 0n;
  velocityBase = 0n;
  readonly shares = new Map<string, bigint>();
  readonly hostExposure = new Map<string, bigint>();
  readonly holderExposure = new Map<string, bigint>();
  readonly policies: Policy[] = [];
  readonly incidents: Incident[] = [];
  readonly registry: Endpoint[] = [];
  readonly endpoints = new Map<string, EndpointState>();
  /** Wallet balances (GEN) so demo deposits / payouts visibly move money. */
  readonly balances = new Map<string, bigint>();
  readonly transfers: { to: string; amount: bigint }[] = [];
  private readonly t0: number;
  private windowStarted = new Map<number, number>();
  private durations = new Map<number, number>();
  private outageStartHead = new Map<number, number>();
  private rng: () => number;

  constructor(startTime: number, cfg: SimConfig = DEFAULT_SIM_CONFIG, seed = 7, governor = "0x00000000000000000000000000000000000000a1") {
    this.now = startTime;
    this.t0 = startTime;
    this.cfg = cfg;
    this.governor = governor.toLowerCase();
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
      ep = { mode: "healthy", block: this.chainHead(), chainId: 1 };
      this.endpoints.set(host, ep);
    }
    return ep;
  }

  /** The simulated chain's height: every healthy provider on it tracks this (independent observers differ by a block or two). */
  chainHead(): number {
    return 21_000_000 + Math.floor((this.now - this.t0) / BLOCK_SECONDS);
  }

  setEndpoint(host: string, mode: EndpointMode): void {
    const ep = this.ensureEndpoint(host);
    // A node that was frozen or down has to resync before it serves the current head again.
    if ((ep.mode === "frozen" || ep.mode === "down") && mode !== "frozen" && mode !== "down") ep.block = this.chainHead();
    ep.mode = mode;
  }

  /** Move the clock; chains that are alive keep producing blocks. */
  advance(seconds: number): void {
    this.now += seconds;
    const head = this.chainHead();
    for (const ep of this.endpoints.values()) {
      if (ep.mode !== "frozen" && ep.mode !== "down") ep.block = head;
    }
    this.refreshViews();
  }

  /** Pool assets minus capital reserved for staged claims and owed payouts: the basis for share pricing and redemptions. */
  netAssets(): bigint {
    return this.poolAssets > this.reservedPayouts ? this.poolAssets - this.reservedPayouts : 0n;
  }

  /** Reserved for claims that are staged but not yet confirmed. */
  stagedReserved(): bigint {
    return this.reservedPayouts > this.owedPayouts ? this.reservedPayouts - this.owedPayouts : 0n;
  }

  /** [paid so far this epoch, payout ceiling for this epoch] */
  velocityWindow(now: number, assets: bigint): [bigint, bigint] {
    const epoch = Math.floor(now / EPOCH_SECONDS);
    if (epoch === this.velocityEpoch && this.velocityBase > 0n) return [this.velocityPaid, (this.velocityBase * MAX_EPOCH_PAYOUT_BPS) / BPS];
    return [0n, (assets * MAX_EPOCH_PAYOUT_BPS) / BPS];
  }

  // ---------------------------------------------------------------- registry
  private onlyGovernor(sender: string): void {
    if (sender.toLowerCase() !== this.governor) throw new ProtocolError(E.unauthorized, "only the registry governor may do this");
  }

  /**
   * Governor-only. The sim authenticates the listing the way the contract does:
   * id/URL/domain rules, then the declared chain id must match what the host serves.
   * (The attestation hash is a placeholder here: the contract recomputes it with SHA-256.)
   */
  registerEndpoint(sender: string, s: RegisterSpec): string {
    this.onlyGovernor(sender);
    if (!ID_RE.test(s.id)) throw new ProtocolError(E.registry, "endpoint_id must be 2-32 chars of [a-z0-9-]");
    if (this.registry.some((e) => e.id === s.id)) throw new ProtocolError(E.registry, "endpoint_id already listed");
    if (this.registry.length >= MAX_ENDPOINTS) throw new ProtocolError(E.registry, "registry is full");
    if (!s.url.toLowerCase().startsWith("https://") || validateEndpointUrl(s.url) !== null) {
      throw new ProtocolError(E.registry, "url must be a public https endpoint");
    }
    const domain = s.domain.trim().toLowerCase();
    const host = hostnameOf(s.url);
    if (domain === "" || apexOf(domain) !== domain) throw new ProtocolError(E.registry, "domain must be a registrable domain");
    if (host !== domain && !host.endsWith(`.${domain}`)) throw new ProtocolError(E.registry, "url host is not under the declared provider domain");
    if (this.registry.some((e) => e.url === s.url)) throw new ProtocolError(E.registry, "url already listed");
    if (this.ensureEndpoint(host).chainId !== s.chainId) throw new ProtocolError(E.registry, `endpoint did not authenticate as chain ${s.chainId}`);
    this.registry.push({
      id: s.id, provider: s.provider, domain, url: s.url, host, apex: apexOf(host), chainId: s.chainId,
      attestation: `sim:${s.id}:${domain}:${s.chainId}`, listedAt: this.now, insurableFrom: this.now + LISTING_DELAY_SECS, status: "LISTED",
    });
    this.log(0, "ENDPOINT_LISTED", sender, `${s.id}: ${s.provider} (${domain}), chain ${s.chainId}, insurable from ${this.now + LISTING_DELAY_SECS}`);
    return s.id;
  }

  delistEndpoint(sender: string, id: string): void {
    this.onlyGovernor(sender);
    const ep = this.registry.find((e) => e.id === id);
    if (!ep) throw new ProtocolError(E.unauth, "endpoint is not in the authenticated registry");
    if (ep.status !== "LISTED") throw new ProtocolError(E.state, "endpoint already delisted");
    ep.status = "DELISTED";
    this.log(0, "ENDPOINT_DELISTED", sender, id);
  }

  endpoint(id: string): Endpoint {
    const ep = this.registry.find((e) => e.id === id);
    if (!ep) throw new ProtocolError(E.unauth, "endpoint is not in the authenticated registry");
    return ep;
  }

  /** Reference set for a chain: first MAX_REFERENCES listed, aged, distinct-provider endpoints other than the insured one. */
  references(chainId: number, apex: string): Endpoint[] {
    const out: Endpoint[] = [];
    const seen = new Set([apex]);
    for (const ep of this.registry) {
      if (out.length >= MAX_REFERENCES) break;
      if (ep.status !== "LISTED" || ep.chainId !== chainId || this.now < ep.listedAt + LISTING_DELAY_SECS) continue;
      if (seen.has(ep.apex)) continue;
      seen.add(ep.apex);
      out.push(ep);
    }
    return out;
  }

  // ------------------------------------------------------------ underwriting
  deposit(sender: string, amount: bigint): bigint {
    if (amount < LIMITS.minDeposit) throw new ProtocolError(E.params, "deposit below minimum");
    // Frozen only while a claim is STAGED (uncertain). Vesting payouts are certain liabilities, already excluded from net assets.
    if (this.stagedReserved() > 0n) throw new ProtocolError(E.frozen, "a staged claim is reserved; deposits reopen when it settles");
    const net = this.netAssets();
    let minted: bigint;
    if (this.totalShares === 0n) minted = amount;
    else {
      if (net === 0n) throw new ProtocolError(E.state, "pool has no assets; deposits closed");
      minted = (amount * this.totalShares) / net;
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
    const net = this.netAssets();
    if (held === 0n || this.totalShares === 0n || net === 0n) throw new ProtocolError(E.liquidity, "no redeemable underwriting position");
    const value = (held * net) / this.totalShares;
    if (amount > value) throw new ProtocolError(E.liquidity, "amount exceeds position value");
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    if (amount > free) throw new ProtocolError(E.liquidity, "capital is locked behind active coverage");
    let burn = (amount * this.totalShares + net - 1n) / net;
    if (burn > held) burn = held;
    this.shares.set(sender, held - burn);
    this.totalShares -= burn;
    this.poolAssets -= amount;
    this.pay(sender, amount);
    return amount;
  }

  underwriter(addr: string): UnderwriterPosition {
    const s = this.shares.get(addr) ?? 0n;
    const value = this.totalShares > 0n ? (s * this.netAssets()) / this.totalShares : 0n;
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    return { shares: s, value, withdrawable: value < free ? value : free };
  }

  // ---------------------------------------------------------------- policies
  quote(coverage: bigint, durationBlocks: number, uptimeBps: number): bigint {
    return quotePremium(coverage, durationBlocks, uptimeBps);
  }

  createPolicy(sender: string, a: CreatePolicyArgs, value: bigint): number {
    const ep = this.registry.find((e) => e.id === a.endpointId);
    if (!ep) throw new ProtocolError(E.unauth, "endpoint is not in the authenticated registry");
    if (ep.status !== "LISTED") throw new ProtocolError(E.unauth, "endpoint has been delisted");
    if (this.now < ep.insurableFrom) throw new ProtocolError(E.unauth, "listing delay has not elapsed");
    if (this.references(ep.chainId, ep.apex).length < MIN_REFERENCES) {
      throw new ProtocolError(E.unauth, `fewer than ${MIN_REFERENCES} independent reference providers on this chain`);
    }
    if (sender.toLowerCase() === this.governor) throw new ProtocolError(E.unauthorized, "the registry governor cannot hold policies");
    if (a.coverage < LIMITS.minCoverage) throw new ProtocolError(E.params, "coverage below minimum");
    if (a.durationBlocks < LIMITS.minDurationBlocks || a.durationBlocks > LIMITS.maxDurationBlocks) throw new ProtocolError(E.params, "duration out of range");
    if (a.minUptimeBps < LIMITS.minUptimeBps || a.minUptimeBps > LIMITS.maxUptimeBps) throw new ProtocolError(E.params, "min_uptime_bps out of range");
    if (a.probeIntervalBlocks < LIMITS.minIntervalBlocks || a.probeIntervalBlocks > LIMITS.maxIntervalBlocks) throw new ProtocolError(E.params, "probe interval out of range");
    const premium = quotePremium(a.coverage, a.durationBlocks, a.minUptimeBps);
    if (value < premium) throw new ProtocolError(E.expected, `premium ${premium} not covered by value ${value}`);

    const apex = ep.apex;
    const hostNow = this.hostExposure.get(apex) ?? 0n;
    const holderNow = this.holderExposure.get(sender) ?? 0n;
    if (a.coverage > (this.poolAssets * CAPS_BPS.policy) / BPS) throw new ProtocolError(E.cap, "coverage exceeds per-policy cap of pool depth");
    if (this.lockedCoverage + a.coverage > (this.poolAssets * CAPS_BPS.utilization) / BPS) throw new ProtocolError(E.cap, "pool utilization cap reached");
    if (hostNow + a.coverage > (this.poolAssets * CAPS_BPS.host) / BPS) throw new ProtocolError(E.cap, "per-provider (registrable domain) exposure cap reached");
    if (holderNow + a.coverage > (this.poolAssets * CAPS_BPS.holder) / BPS) throw new ProtocolError(E.cap, "per-holder exposure cap reached");

    this.debit(sender, value);
    const durationSecs = a.durationBlocks * BLOCK_SECONDS;
    const id = this.policies.length + 1;
    const activeFrom = this.now + this.cfg.activationDelay;
    this.policies.push({
      id, holder: sender, endpointId: ep.id, endpointUrl: ep.url, host: ep.host, apex, chainId: ep.chainId,
      minUptimeBps: a.minUptimeBps, probeInterval: a.probeIntervalBlocks * BLOCK_SECONDS,
      coverage: a.coverage, premium, createdAt: this.now, activeFrom, expiresAt: activeFrom + durationSecs,
      status: "ACTIVE", samplesTotal: 0, samplesOk: 0, uptimeBps: 10_000, inconclusiveRounds: 0, downtimeSecs: 0,
      consecutiveFailures: 0, outageStartedAt: 0, outageBlocks: 0, baselineOk: false,
      lastProbeAt: 0, lastBlock: 0, lastRefHead: 0, lastReason: "", lastOk: false, settleAt: 0, claimCount: 0,
      payout: 0n, released: 0n, releasable: 0n, vestStart: 0,
    });
    this.durations.set(id, durationSecs);
    this.windowStarted.set(id, activeFrom);
    this.lockedCoverage += a.coverage;
    this.hostExposure.set(apex, hostNow + a.coverage);
    this.holderExposure.set(sender, holderNow + a.coverage);
    this.activePolicies += 1;
    this.runRate += (premium * BigInt(YEAR_SECONDS)) / BigInt(durationSecs);
    this.poolAssets += premium;
    this.totalPremiums += premium;
    this.log(id, "POLICY_CREATED", sender, `${ep.id}: coverage ${a.coverage}, premium ${premium}, ${a.minUptimeBps} bps uptime`);
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
  /** One validator's look at one host. `jitter` models the few blocks independent observers can disagree by. */
  private measure(host: string, jitter: boolean): Observation {
    const ep = this.ensureEndpoint(host);
    const block = ep.block + (jitter ? Math.floor(this.rng() * 2) : 0);
    switch (ep.mode) {
      case "down": return { ok: false, reason: "UNREACHABLE", status: 0, block: -1 };
      case "http502": return { ok: false, reason: "HTTP_ERROR", status: 502, block: -1 };
      case "http504": return { ok: false, reason: "HTTP_ERROR", status: 504, block: -1 };
      case "ratelimited": return { ok: false, reason: "RATE_LIMITED", status: 429, block: -1 };
      case "badpayload": return { ok: false, reason: "BAD_PAYLOAD", status: 200, block: -1 };
      default: return { ok: true, reason: "OK", status: 200, block };
    }
  }

  /** One validator's full corroborated round: the target plus every reference. Never throws. */
  private observeRound(p: Policy, refs: Endpoint[]): Round {
    const t = this.measure(p.host, true);
    const refObs = refs.map((r) => {
      const o = this.measure(r.host, true);
      return { id: r.id, ok: o.ok, block: o.block };
    });
    const c = classify(t, refObs, refs.length);
    return { ...c, status: t.status, block: t.block, refsTotal: refs.length, refIds: refs.map((r) => r.id), refs: refObs };
  }

  /** Mirror of `_round_agrees`: same reference set, same verdict, and the leader's reported heights are plausible. */
  private agrees(lead: Round, mine: Round): boolean {
    if (lead.refIds.join() !== mine.refIds.join()) return false;
    if (lead.verdict !== mine.verdict || lead.reason !== mine.reason) return false;
    if (lead.verdict === "INCONCLUSIVE") return true;
    if (lead.block > 0 && mine.block > 0) {
      if (lead.block < mine.block - MAX_BLOCK_DRIFT || lead.block > mine.block + MAX_BLOCK_AHEAD) return false;
    }
    return true;
  }

  /** Leader + validators observe independently; the leader's verdict stands only if the quorum agrees. */
  private consensus(p: Policy): { leader: Round; votes: ConsensusVote[] } {
    const refs = this.references(p.chainId, p.apex);
    const leader = this.observeRound(p, refs);
    const vote = (name: string, role: ConsensusVote["role"], r: Round, agree: boolean): ConsensusVote => ({
      validator: name, role, agree, verdict: r.verdict, reason: r.reason, status: r.status, block: r.block, refHead: r.refHead, refsOk: r.refsOk,
    });
    const votes: ConsensusVote[] = [vote("validator-1", "leader", leader, true)];
    for (let i = 2; i <= VALIDATORS; i++) {
      const mine = this.observeRound(p, refs);
      votes.push(vote(`validator-${i}`, "validator", mine, this.agrees(leader, mine)));
    }
    const agreeing = votes.filter((v) => v.agree).length;
    if (agreeing * 2 <= VALIDATORS) throw new ProtocolError("[NO_CONSENSUS]", "validators rejected the leader's observation; retry");
    return { leader, votes };
  }

  /** Time-weighted uptime (mirror of `_uptime_bps`): downtime over the elapsed window, floored at 24 h. */
  private uptimeAt(p: Policy, now: number): number {
    const started = this.windowStarted.get(p.id) ?? p.activeFrom;
    if (now - started >= MEASUREMENT_WINDOW_SECS) return 10_000;
    const span = Math.max(now - started, MIN_UPTIME_WINDOW_SECS);
    const down = Math.floor((p.downtimeSecs * 10_000) / span);
    return down < 10_000 ? 10_000 - down : 0;
  }

  /** Recompute the read-time fields of the policy views (the contract derives these in `_policy_dict`). */
  private refreshViews(): void {
    for (const p of this.policies) {
      p.uptimeBps = this.uptimeAt(p, this.now);
      const startHead = this.outageStartHead.get(p.id) ?? 0;
      p.outageBlocks = p.outageStartedAt > 0 && p.lastRefHead > startHead ? p.lastRefHead - startHead : 0;
      if (p.status === "VESTING") {
        const due = releasableBy(p.payout, p.vestStart, this.now) - p.released;
        p.releasable = due > 0n ? due : 0n;
      } else p.releasable = 0n;
    }
  }

  private describe(r: Round): string {
    const corr = `${r.refsOk}/${r.refsTotal} references healthy, reference head ${r.refHead}`;
    if (r.verdict === "HEALTHY") return `healthy: HTTP 200, block ${r.block} (${corr})`;
    if (r.verdict === "INCONCLUSIVE") {
      if (r.reason === "RATE_LIMITED") return `endpoint rate-limited the observers; not a representative outage (${corr})`;
      return `not corroborated: reference baseline unavailable (${r.refsOk}/${r.refsTotal} healthy)`;
    }
    switch (r.reason) {
      case "UNREACHABLE": return `endpoint unreachable while the network is healthy (${corr})`;
      case "HTTP_ERROR": return `HTTP ${r.status} returned, SLA requires 200 (${corr})`;
      case "BAD_PAYLOAD": return `eth_blockNumber returned an invalid or missing result (${corr})`;
      default: return `block ${r.block} is more than ${MAX_LAG_BLOCKS} behind reference head ${r.refHead} (${corr})`;
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

    // Measurement window rollover, aligned to the policy's own clock.
    const ws = this.windowStarted.get(id) ?? p.activeFrom;
    if (this.now - ws >= MEASUREMENT_WINDOW_SECS) {
      const age = this.now - p.activeFrom;
      this.windowStarted.set(id, p.activeFrom + Math.floor(age / MEASUREMENT_WINDOW_SECS) * MEASUREMENT_WINDOW_SECS);
      p.downtimeSecs = 0;
      p.samplesTotal = 0;
      p.samplesOk = 0;
    }
    this.totalProbes += 1;
    p.lastProbeAt = this.now;
    p.lastReason = obs.reason;
    p.lastOk = obs.verdict === "HEALTHY";
    if (obs.block > 0) p.lastBlock = obs.block;

    let forfeit = 0n;
    let staged = false;
    if (obs.verdict === "INCONCLUSIVE") {
      // No baseline: neither a failure nor a recovery. Streak, downtime and baseline untouched; bond refunded in full.
      p.inconclusiveRounds += 1;
    } else {
      p.samplesTotal += 1;
      p.lastRefHead = obs.refHead;
      if (obs.verdict === "HEALTHY") {
        p.samplesOk += 1;
        p.consecutiveFailures = 0;
        p.outageStartedAt = 0;
        this.outageStartHead.set(id, 0);
        p.baselineOk = true;
        forfeit = this.cfg.probeBond;
        this.poolAssets += forfeit;
        this.totalBondForfeits += forfeit;
      } else {
        if (p.consecutiveFailures === 0) {
          p.outageStartedAt = this.now;
          this.outageStartHead.set(id, obs.refHead);
        }
        p.consecutiveFailures += 1;
        p.downtimeSecs += p.probeInterval;
      }
      staged = this.maybeStage(id, p, obs.refHead);
    }
    this.refreshViews();
    this.log(id, "PROBE", sender, this.describe(obs), obs, votes);
    this.pay(sender, bond - forfeit);
    return { ...obs, ok: obs.verdict === "HEALTHY", votes, breachStaged: staged, consecutiveFailures: p.consecutiveFailures, uptimeBps: p.uptimeBps };
  }

  private maybeStage(id: number, p: Policy, refHead: number): boolean {
    if (p.consecutiveFailures < BREACH_CONSECUTIVE || !p.baselineOk) return false;
    if (p.outageStartedAt === 0 || this.now - p.outageStartedAt < MIN_OUTAGE_SECS) return false;
    const blocks = refHead - (this.outageStartHead.get(id) ?? 0);
    if (blocks < MIN_OUTAGE_BLOCKS) return false;
    const up = this.uptimeAt(p, this.now);
    if (up >= p.minUptimeBps) return false;
    p.status = "BREACH_PENDING";
    p.settleAt = this.now + this.cfg.claimGrace;
    p.claimCount += 1;
    this.reservedPayouts += p.coverage;
    this.totalBreaches += 1;
    this.log(id, "BREACH_STAGED", "",
      `${p.consecutiveFailures} corroborated failing rounds over ${this.now - p.outageStartedAt}s and ${blocks} blocks; uptime ${up} bps < ${p.minUptimeBps} bps SLA; payout reserved, grace until ${p.settleAt}`);
    return true;
  }

  settleClaim(sender: string, id: number, bond: bigint) {
    const p = this.get(id);
    if (p.status !== "BREACH_PENDING") throw new ProtocolError(E.state, "no staged claim on this policy");
    if (this.now < p.settleAt) throw new ProtocolError(E.soon, "claim grace period has not elapsed");
    if (this.now > p.settleAt + SETTLE_WINDOW) throw new ProtocolError(E.state, "claim lapsed; call expire_policy");
    if (bond < this.cfg.probeBond) throw new ProtocolError(E.expected, `probe bond ${this.cfg.probeBond} required`);
    const { leader: obs, votes } = this.consensus(p);
    if (obs.verdict === "INCONCLUSIVE") throw new ProtocolError(E.inconclusive, "re-verification could not be corroborated; retry");
    const text = this.describe(obs);

    if (obs.verdict === "FAILING") {
      let payout = vestedPayout(p.coverage, this.now - p.activeFrom);
      if (payout > this.poolAssets) payout = this.poolAssets;
      // Claim velocity ceiling; the first confirmation of an epoch is always allowed (progress guarantee).
      const [paidNow, ceiling] = this.velocityWindow(this.now, this.poolAssets);
      if (paidNow > 0n && paidNow + payout > ceiling) throw new ProtocolError(E.velocity, "epoch payout ceiling reached; retry next epoch");
      this.debit(sender, bond);
      const epoch = Math.floor(this.now / EPOCH_SECONDS);
      if (epoch !== this.velocityEpoch) {
        this.velocityEpoch = epoch;
        this.velocityBase = this.poolAssets;
        this.velocityPaid = 0n;
      }
      this.velocityPaid += payout;
      this.totalProbes += 1;
      p.payout = payout;
      p.released = 0n;
      p.vestStart = this.now;
      p.lastReason = obs.reason;
      p.lastOk = false;
      p.lastProbeAt = this.now;
      this.beginVesting(p, payout);
      this.refreshViews();
      this.log(id, "BREACH_CONFIRMED_VESTING", sender,
        `re-verification confirmed breach (${text}); ${payout} of ${p.coverage} coverage vests after a ${PAYOUT_COOLDOWN_SECS}s cooldown over ${PAYOUT_VEST_SECS}s`, obs, votes);
      this.pay(sender, bond);
      return {
        confirmed: true, payout, reason: obs.reason, votes,
        releasableFrom: this.now + PAYOUT_COOLDOWN_SECS, fullyVestedAt: this.now + PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS,
      };
    }

    // Endpoint recovered during the grace period: dismiss, resume cover.
    this.debit(sender, bond);
    this.totalProbes += 1;
    const forfeit = this.cfg.probeBond;
    this.poolAssets += forfeit;
    this.totalBondForfeits += forfeit;
    this.reservedPayouts -= p.coverage;
    p.status = "ACTIVE";
    p.consecutiveFailures = 0;
    p.outageStartedAt = 0;
    this.outageStartHead.set(id, 0);
    p.lastOk = true;
    p.lastReason = "OK";
    p.lastProbeAt = this.now;
    if (obs.block > 0) p.lastBlock = obs.block;
    this.refreshViews();
    this.log(id, "CLAIM_DISMISSED", sender, `endpoint recovered during grace period (${text})`, obs, votes);
    this.pay(sender, bond - forfeit);
    return { confirmed: false, payout: 0n, reason: "OK" as ProbeReason, votes };
  }

  /** Permissionless: pays the HOLDER the vested portion of a confirmed payout. */
  releasePayout(_sender: string, id: number): { released: bigint; totalReleased: bigint; payout: bigint; done: boolean } {
    const p = this.get(id);
    if (p.status !== "VESTING") throw new ProtocolError(E.state, "policy has no vesting payout");
    const due = releasableBy(p.payout, p.vestStart, this.now) - p.released;
    if (due <= 0n) throw new ProtocolError(E.soon, "nothing has vested yet");
    p.released += due;
    this.owedPayouts -= due;
    this.reservedPayouts -= due;
    this.lockedCoverage -= due;
    this.poolAssets -= due;
    this.totalPayouts += due;
    const done = p.released >= p.payout;
    if (done) p.status = "PAID";
    this.refreshViews();
    this.log(id, "PAYOUT_RELEASED", _sender, `released ${due} (${p.released} of ${p.payout})`);
    this.pay(p.holder, due);
    return { released: due, totalReleased: p.released, payout: p.payout, done };
  }

  private releaseExposure(p: Policy, cov: bigint): void {
    this.hostExposure.set(p.apex, (this.hostExposure.get(p.apex) ?? 0n) - cov);
    this.holderExposure.set(p.holder, (this.holderExposure.get(p.holder) ?? 0n) - cov);
    this.activePolicies -= 1;
    this.runRate -= (p.premium * BigInt(YEAR_SECONDS)) / BigInt(this.durations.get(p.id) ?? 1);
  }

  private close(id: number, status: PolicyStatus): void {
    const p = this.get(id);
    if (p.status === "BREACH_PENDING") this.reservedPayouts -= p.coverage;
    this.lockedCoverage -= p.coverage;
    this.releaseExposure(p, p.coverage);
    p.status = status;
    this.refreshViews();
  }

  /** Breach confirmed: exposure is released, the unpaid slice of coverage returns to the pool, the payout becomes a reserved liability. */
  private beginVesting(p: Policy, payout: bigint): void {
    this.reservedPayouts = this.reservedPayouts - p.coverage + payout;
    this.owedPayouts += payout;
    this.lockedCoverage = this.lockedCoverage - p.coverage + payout;
    this.releaseExposure(p, p.coverage);
    p.status = "VESTING";
  }

  private log(policyId: number, kind: IncidentKind, by: string, detail: string, obs?: Round, votes?: ConsensusVote[]): void {
    const inc: Incident = { index: this.incidents.length, time: this.now, policyId, kind, detail, by };
    if (obs) {
      inc.ok = obs.verdict === "HEALTHY";
      inc.verdict = obs.verdict;
      inc.reason = obs.reason;
      inc.status = obs.status;
      inc.block = obs.block;
      inc.refHead = obs.refHead;
      inc.refsOk = obs.refsOk;
      inc.refsTotal = obs.refsTotal;
    }
    if (votes) inc.votes = votes;
    this.incidents.push(inc);
  }

  // ------------------------------------------------------------------- views
  metrics(): PoolMetrics {
    const free = this.poolAssets > this.lockedCoverage ? this.poolAssets - this.lockedCoverage : 0n;
    const [epochPaid, epochCeiling] = this.velocityWindow(this.now, this.poolAssets);
    return {
      tvl: this.poolAssets,
      netAssets: this.netAssets(),
      totalShares: this.totalShares,
      sharePrice: this.totalShares > 0n ? (this.netAssets() * ATTO) / this.totalShares : ATTO,
      epochPaid,
      epochCeiling,
      maxEpochPayoutBps: Number(MAX_EPOCH_PAYOUT_BPS),
      lockedCoverage: this.lockedCoverage,
      reservedPayouts: this.reservedPayouts,
      owedPayouts: this.owedPayouts,
      stagedClaims: this.stagedReserved(),
      listedEndpoints: this.registry.length,
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
      solvent: this.lockedCoverage <= this.poolAssets && this.reservedPayouts <= this.lockedCoverage && this.owedPayouts <= this.reservedPayouts,
    };
  }
}
