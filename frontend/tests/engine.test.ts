import { beforeEach, describe, expect, it } from "vitest";
import { classify, DEFAULT_SIM_CONFIG, ProtocolError, SimProtocol } from "@/lib/sim/engine";
import { createDemoWorld, DEMO_ACCOUNT, DEMO_GOVERNOR } from "@/lib/sim/seed";
import {
  LISTING_DELAY_SECS, MAX_LAG_BLOCKS, minDurationBlocks, PAYOUT_COOLDOWN_SECS, PAYOUT_VEST_SECS, quotePremium, vestedPayout,
} from "@/lib/pricing";
import type { CreatePolicyArgs } from "@/lib/types";
import { ATTO } from "@/lib/units";

const T0 = 1_800_000_000;
const BOND = DEFAULT_SIM_CONFIG.probeBond;
const GRACE = DEFAULT_SIM_CONFIG.claimGrace;
const GOV = "0x00000000000000000000000000000000000000a1";
const UW = "0xuw";
const OP = "0xop";
const BOT = "0xbot";

const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"] as const;
/** Listed LAST, so the references of each (alpha..delta) are healthy even when all four fail together. */
const LATE = ["eta", "theta", "iota", "kappa"] as const;
const host = (n: string) => `rpc.node-${n}.io`;

const args = (over: Partial<CreatePolicyArgs> = {}): CreatePolicyArgs => ({
  endpointId: "alpha", coverage: 5n * ATTO, durationBlocks: 100_000, minUptimeBps: 9990, probeIntervalBlocks: 5, ...over,
});

/** A registry of ten independent providers (plus a second alpha endpoint), aged past the listing delay, and a funded pool. */
function world(pool = 100n): SimProtocol {
  const sim = new SimProtocol(T0, DEFAULT_SIM_CONFIG, 7, GOV);
  for (const a of [UW, OP, BOT, "0xa", "0xb", "0xc", "0xd", "0xe"]) sim.fund(a, 10_000n * ATTO);
  for (const n of NAMES) sim.registerEndpoint(GOV, { id: n, provider: `Provider ${n}`, domain: `node-${n}.io`, chainId: 1, url: `https://${host(n)}` });
  sim.registerEndpoint(GOV, { id: "alpha-two", provider: "Provider alpha", domain: "node-alpha.io", chainId: 1, url: "https://rpc2.node-alpha.io" });
  sim.advance(LISTING_DELAY_SECS + 1);
  if (pool > 0n) sim.deposit(UW, pool * ATTO);
  return sim;
}
const mint = (sim: SimProtocol, holder = OP, a: Partial<CreatePolicyArgs> = {}) => {
  const full = args(a);
  return sim.createPolicy(holder, full, quotePremium(full.coverage, full.durationBlocks, full.minUptimeBps));
};
const revertsWith = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    expect((e as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};
const hostOf = (sim: SimProtocol, id: number) => sim.get(id).host;
const refHosts = (sim: SimProtocol, id: number) => {
  const p = sim.get(id);
  return sim.references(p.chainId, p.apex).map((e) => e.host);
};

/**
 * Failing rounds, 10 minutes apart, until every policy has staged its claim. Staging needs three corroborated
 * failures spanning 15 minutes and 25 blocks AND time-weighted uptime below the SLA, so an old policy needs more rounds.
 */
function failUntilStaged(sim: SimProtocol, ids: number[]) {
  for (let i = 0; i < 60 && ids.some((id) => sim.get(id).status === "ACTIVE"); i++) {
    sim.advance(600);
    for (const id of ids) if (sim.get(id).status === "ACTIVE") sim.triggerProbe(BOT, id, BOND);
  }
  expect(ids.every((id) => sim.get(id).status === "BREACH_PENDING")).toBe(true);
}

/** One healthy baseline round, then the endpoint goes bad until a corroborated, continuous outage stages the claim. */
function stage(sim: SimProtocol, id: number, mode: "http502" | "down" | "http504" = "http502") {
  const h = hostOf(sim, id);
  sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
  sim.setEndpoint(h, "healthy");
  expect(sim.triggerProbe(BOT, id, BOND).ok).toBe(true);
  sim.setEndpoint(h, mode);
  failUntilStaged(sim, [id]);
}

describe("underwriting", () => {
  it("mints 1:1 first, then pro-rata after premium accrues", () => {
    const sim = world();
    expect(sim.metrics().sharePrice).toBe(ATTO);
    const id = mint(sim);
    expect(id).toBe(1);
    const premium = quotePremium(5n * ATTO, 100_000, 9990);
    expect(sim.metrics().tvl).toBe(100n * ATTO + premium);
    const minted = sim.deposit("0xa", 50n * ATTO);
    expect(minted).toBe((50n * ATTO * 100n * ATTO) / (100n * ATTO + premium));
  });
  it("blocks withdrawals of locked capital but allows the free portion", () => {
    const sim = world();
    mint(sim, OP, { coverage: 10n * ATTO });
    const free = sim.metrics().freeLiquidity;
    revertsWith(() => sim.withdraw(UW, free + 1n), "[INSUFFICIENT_LIQUIDITY]");
    sim.withdraw(UW, free);
    expect(sim.metrics().solvent).toBe(true);
    expect(sim.metrics().tvl).toBe(10n * ATTO);
  });
  it("rejects dust, zero and strangers", () => {
    const sim = world();
    revertsWith(() => sim.deposit("0xa", 10n ** 14n), "[INVALID_PARAMS]");
    revertsWith(() => sim.withdraw(UW, 0n), "[INVALID_PARAMS]");
    revertsWith(() => sim.withdraw("0xa", 1n), "[INSUFFICIENT_LIQUIDITY]");
  });
  it("debits and credits wallet balances", () => {
    const sim = world(0n);
    const before = sim.balanceOf("0xa");
    sim.deposit("0xa", 7n * ATTO);
    expect(sim.balanceOf("0xa")).toBe(before - 7n * ATTO);
    sim.withdraw("0xa", 7n * ATTO);
    expect(sim.balanceOf("0xa")).toBe(before);
    revertsWith(() => sim.deposit("0xbroke", ATTO), "[EXPECTED]");
  });
});

describe("authenticated registry", () => {
  const spec = { id: "omega", provider: "Omega", domain: "node-omega.io", chainId: 1, url: "https://rpc.node-omega.io" };

  it("only the governor may list or delist", () => {
    const sim = world();
    revertsWith(() => sim.registerEndpoint(OP, spec), "[UNAUTHORIZED]");
    revertsWith(() => sim.delistEndpoint(OP, "alpha"), "[UNAUTHORIZED]");
    expect(sim.registerEndpoint(GOV, spec)).toBe("omega");
  });

  it.each([
    ["a malformed id", { id: "Bad ID" }],
    ["a duplicate id", { id: "alpha", domain: "node-omega.io" }],
    ["an http URL", { url: "http://rpc.node-omega.io" }],
    ["a private address", { url: "https://10.0.0.5" }],
    ["a URL outside the declared domain", { domain: "someone-else.io" }],
    ["a non-registrable domain", { domain: "rpc.node-omega.io" }],
    ["an already-listed URL", { url: `https://${host("alpha")}`, domain: "node-alpha.io" }],
  ])("rejects %s", (_name, over) => {
    revertsWith(() => world().registerEndpoint(GOV, { ...spec, ...over }), "[REGISTRY_REJECTED]");
  });

  it("rejects an endpoint that does not authenticate as the declared chain", () => {
    const sim = world();
    sim.ensureEndpoint("rpc.node-omega.io").chainId = 137;
    revertsWith(() => sim.registerEndpoint(GOV, spec), "[REGISTRY_REJECTED]");
  });

  it("is capped at 32 listings", () => {
    const sim = world();
    for (let i = sim.registry.length; i < 32; i++) {
      sim.registerEndpoint(GOV, { id: `fill-${i}`, provider: `Fill ${i}`, domain: `fill-${i}.io`, chainId: 1, url: `https://rpc.fill-${i}.io` });
    }
    revertsWith(() => sim.registerEndpoint(GOV, spec), "[REGISTRY_REJECTED]");
  });

  it("a fresh listing is not insurable and not a reference until its delay has elapsed", () => {
    const sim = new SimProtocol(T0, DEFAULT_SIM_CONFIG, 7, GOV);
    for (const a of [UW, OP]) sim.fund(a, 10_000n * ATTO);
    for (const n of ["alpha", "beta", "gamma", "delta"]) {
      sim.registerEndpoint(GOV, { id: n, provider: n, domain: `node-${n}.io`, chainId: 1, url: `https://${host(n)}` });
    }
    sim.advance(LISTING_DELAY_SECS + 1);
    sim.deposit(UW, 100n * ATTO);
    sim.registerEndpoint(GOV, spec);
    revertsWith(() => mint(sim, OP, { endpointId: "omega" }), "[UNAUTHENTICATED_ENDPOINT]");
    const id = mint(sim);
    expect(refHosts(sim, id)).toEqual([host("beta"), host("gamma"), host("delta")]); // omega has not aged
    sim.advance(LISTING_DELAY_SECS);
    expect(refHosts(sim, id)).toContain("rpc.node-omega.io");
    expect(mint(sim, OP, { endpointId: "omega" })).toBeGreaterThan(id);
  });

  it("insures registry ids only: unknown ids and raw URLs are unauthenticated", () => {
    const sim = world();
    for (const bad of ["not-listed", "https://rpc.attacker.io", ""]) {
      revertsWith(() => mint(sim, OP, { endpointId: bad }), "[UNAUTHENTICATED_ENDPOINT]");
    }
  });

  it("a delisted endpoint cannot be insured, stops being a reference, and existing policies keep running", () => {
    const sim = world();
    const id = mint(sim);
    sim.delistEndpoint(GOV, "beta");
    expect(refHosts(sim, id)).not.toContain(host("beta"));
    sim.delistEndpoint(GOV, "alpha");
    revertsWith(() => mint(sim, OP, { endpointId: "alpha" }), "[UNAUTHENTICATED_ENDPOINT]");
    revertsWith(() => sim.delistEndpoint(GOV, "alpha"), "[INVALID_STATE]");
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    expect(sim.triggerProbe(BOT, id, BOND).ok).toBe(true);
  });

  it("needs at least three independent reference providers", () => {
    const sim = new SimProtocol(T0, DEFAULT_SIM_CONFIG, 7, GOV);
    sim.fund(UW, 1000n * ATTO);
    sim.fund(OP, 1000n * ATTO);
    for (const n of ["alpha", "beta", "gamma"]) {
      sim.registerEndpoint(GOV, { id: n, provider: n, domain: `node-${n}.io`, chainId: 1, url: `https://${host(n)}` });
    }
    sim.advance(LISTING_DELAY_SECS + 1);
    sim.deposit(UW, 100n * ATTO);
    revertsWith(() => mint(sim), "[UNAUTHENTICATED_ENDPOINT]"); // two references only
  });

  it("references are other providers on the same chain, never the insured provider's own endpoints", () => {
    const sim = world();
    const id = mint(sim);
    const refs = refHosts(sim, id);
    expect(refs).toHaveLength(4);
    expect(refs).not.toContain(host("alpha"));
    expect(refs).not.toContain("rpc2.node-alpha.io"); // same registrable domain as the insured endpoint
  });

  it("the governor cannot hold a policy", () => {
    revertsWith(() => mint(world(), GOV), "[UNAUTHORIZED]");
  });
});

describe("policy creation", () => {
  it("enforces parameter bounds", () => {
    const sim = world();
    const cases: Partial<CreatePolicyArgs>[] = [
      { durationBlocks: 299 }, { minUptimeBps: 8999 }, { probeIntervalBlocks: 4 }, { coverage: 10n ** 15n - 1n },
    ];
    for (const c of cases) revertsWith(() => sim.createPolicy(OP, args(c), ATTO), "[INVALID_PARAMS]");
  });
  it("rejects underpayment and refunds overpayment", () => {
    const sim = world();
    const q = quotePremium(5n * ATTO, 100_000, 9990);
    revertsWith(() => sim.createPolicy(OP, args(), q - 1n), "[EXPECTED]");
    const bal = sim.balanceOf(OP);
    sim.createPolicy(OP, args(), q + 3n * ATTO);
    expect(sim.balanceOf(OP)).toBe(bal - q);
  });
  it("snapshots the immutable listing onto the policy", () => {
    const sim = world();
    const p = sim.get(mint(sim));
    expect(p).toMatchObject({ endpointId: "alpha", host: host("alpha"), apex: "node-alpha.io", chainId: 1, endpointUrl: `https://${host("alpha")}` });
  });
  it("enforces every exposure cap", () => {
    const sim = world();
    revertsWith(() => mint(sim, OP, { coverage: 11n * ATTO }), "[EXPOSURE_CAP]"); // per policy
    mint(sim, "0xa", { coverage: 10n * ATTO });
    mint(sim, "0xb", { coverage: 10n * ATTO }); // provider at 20%
    revertsWith(() => mint(sim, "0xc", { coverage: ATTO }), "[EXPOSURE_CAP]"); // per provider
    mint(sim, "0xa", { coverage: 10n * ATTO, endpointId: "beta" });
    revertsWith(() => mint(sim, "0xa", { coverage: ATTO, endpointId: "gamma" }), "[EXPOSURE_CAP]"); // per holder
  });
  it("caps total utilization at 80%", () => {
    const sim = world();
    const holders = ["0xa", "0xb", "0xc", "0xd"];
    const ends = ["alpha", "beta", "gamma", "delta"];
    for (let i = 0; i < 8; i++) mint(sim, holders[Math.floor(i / 2)], { coverage: 10n * ATTO, endpointId: ends[Math.floor(i / 2)] });
    expect(sim.metrics().utilizationBps).toBeLessThanOrEqual(8000);
    revertsWith(() => mint(sim, "0xe", { coverage: 5n * ATTO, endpointId: "epsilon" }), "[EXPOSURE_CAP]");
  });
  it("an empty pool writes no policies", () => {
    revertsWith(() => mint(world(0n)), "[EXPOSURE_CAP]");
  });
  it("groups exposure by registrable domain, not by registry id", () => {
    const sim = world();
    mint(sim, "0xa", { coverage: 10n * ATTO, endpointId: "alpha" });
    mint(sim, "0xb", { coverage: 10n * ATTO, endpointId: "alpha-two" });
    revertsWith(() => mint(sim, "0xc", { coverage: ATTO, endpointId: "alpha" }), "[EXPOSURE_CAP]");
    expect(sim.get(2).apex).toBe("node-alpha.io");
  });
});

describe("corroborated probes", () => {
  let sim: SimProtocol;
  let id: number;
  beforeEach(() => {
    sim = world();
    id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
  });

  it("a healthy round records the baseline, the reference head, and forfeits the bond", () => {
    const tvl = sim.metrics().tvl;
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ ok: true, verdict: "HEALTHY", refsTotal: 4, refsOk: 4 });
    expect(r.votes).toHaveLength(5);
    expect(sim.get(id)).toMatchObject({ baselineOk: true, samplesOk: 1, uptimeBps: 10_000 });
    expect(sim.get(id).lastRefHead).toBeGreaterThan(0);
    expect(sim.metrics().tvl).toBe(tvl + BOND);
  });

  it.each([
    ["http502", "HTTP_ERROR", 502], ["http504", "HTTP_ERROR", 504], ["down", "UNREACHABLE", 0], ["badpayload", "BAD_PAYLOAD", 200],
  ] as const)("%s is a corroborated FAILING round (%s) and refunds the bond", (mode, reason, status) => {
    sim.setEndpoint(hostOf(sim, id), mode);
    const tvl = sim.metrics().tvl;
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ ok: false, verdict: "FAILING", reason, status });
    expect(sim.metrics().tvl).toBe(tvl);
    expect(sim.transfers.at(-1)).toEqual({ to: BOT, amount: BOND });
  });

  it("detects a block height frozen far behind the corroborated head", () => {
    const h = hostOf(sim, id);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(h, "frozen");
    sim.advance(61); // 5 blocks: within tolerance
    expect(sim.triggerProbe(BOT, id, BOND).verdict).toBe("HEALTHY");
    sim.advance((MAX_LAG_BLOCKS + 20) * 12);
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ verdict: "FAILING", reason: "STALE_BLOCK" });
  });

  it("rate limiting is INCONCLUSIVE: it never counts as downtime and the bond comes back", () => {
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "ratelimited");
    for (let i = 0; i < 6; i++) {
      sim.advance(600);
      const r = sim.triggerProbe(BOT, id, BOND);
      expect(r).toMatchObject({ verdict: "INCONCLUSIVE", reason: "RATE_LIMITED" });
    }
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0, downtimeSecs: 0, inconclusiveRounds: 6, samplesTotal: 1 });
    expect(sim.transfers.at(-1)).toEqual({ to: BOT, amount: BOND });
  });

  it("an outage seen by the observers but not by the references is inconclusive", () => {
    sim.triggerProbe(BOT, id, BOND);
    // The network around the observer is broken: the target and most references do not answer.
    sim.setEndpoint(hostOf(sim, id), "down");
    for (const h of refHosts(sim, id).slice(0, 3)) sim.setEndpoint(h, "down");
    sim.advance(600);
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ verdict: "INCONCLUSIVE", reason: "NO_BASELINE", refsOk: 1 });
    expect(sim.get(id)).toMatchObject({ consecutiveFailures: 0, downtimeSecs: 0 });
  });

  it("one unhealthy reference does not stop corroboration", () => {
    sim.setEndpoint(refHosts(sim, id)[0], "down");
    sim.setEndpoint(hostOf(sim, id), "http502");
    expect(sim.triggerProbe(BOT, id, BOND)).toMatchObject({ verdict: "FAILING", refsOk: 3 });
  });

  it("a single reference far ahead cannot make a healthy target look stale (lower-median head)", () => {
    sim.ensureEndpoint(refHosts(sim, id)[3]).block += 100_000;
    expect(sim.triggerProbe(BOT, id, BOND)).toMatchObject({ verdict: "HEALTHY" });
  });

  it("enforces activation delay, interval and bond", () => {
    const fresh = mint(sim);
    revertsWith(() => sim.triggerProbe(BOT, fresh, BOND), "[TOO_SOON]");
    sim.triggerProbe(BOT, id, BOND);
    revertsWith(() => sim.triggerProbe(BOT, id, BOND), "[TOO_SOON]");
    sim.advance(61);
    revertsWith(() => sim.triggerProbe(BOT, id, BOND - 1n), "[EXPECTED]");
  });

  it("every round has a validator quorum", () => {
    for (let i = 0; i < 30; i++) {
      const r = sim.triggerProbe(BOT, id, BOND);
      expect(r.votes.filter((v) => v.agree).length).toBeGreaterThanOrEqual(3);
      sim.advance(61);
    }
  });

  it("classify mirrors the contract's rules", () => {
    const ok = (block: number) => ({ ok: true, block });
    const refs = [ok(1000), ok(1001), ok(1002), { ok: false, block: -1 }];
    const t = (o: Partial<{ ok: boolean; reason: string; status: number; block: number }>) => ({ ok: true, reason: "OK", status: 200, block: 1001, ...o }) as never;
    expect(classify(t({}), refs, 4)).toMatchObject({ verdict: "HEALTHY", refHead: 1001, refsOk: 3 });
    expect(classify(t({ block: 1001 - MAX_LAG_BLOCKS - 1 }), refs, 4)).toMatchObject({ verdict: "FAILING", reason: "STALE_BLOCK" });
    expect(classify(t({ block: 1001 - MAX_LAG_BLOCKS }), refs, 4)).toMatchObject({ verdict: "HEALTHY" });
    expect(classify(t({ ok: false, reason: "UNREACHABLE", block: -1 }), refs, 4)).toMatchObject({ verdict: "FAILING", reason: "UNREACHABLE" });
    expect(classify(t({ ok: false, reason: "RATE_LIMITED", block: -1 }), refs, 4)).toMatchObject({ verdict: "INCONCLUSIVE", reason: "RATE_LIMITED" });
    expect(classify(t({}), [ok(1000), { ok: false, block: -1 }, { ok: false, block: -1 }], 3)).toMatchObject({ verdict: "INCONCLUSIVE", reason: "NO_BASELINE" });
    expect(classify(t({}), [ok(1000), ok(1001)], 2)).toMatchObject({ verdict: "INCONCLUSIVE", reason: "NO_BASELINE" });
  });
});

describe("continuity and staged claims", () => {
  it("a corroborated outage across several rounds, minutes and blocks stages a claim", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    const p = sim.get(id);
    expect(p.status).toBe("BREACH_PENDING");
    expect(p.settleAt).toBe(sim.now + GRACE);
    expect(p.outageBlocks).toBeGreaterThanOrEqual(25);
    expect(sim.metrics()).toMatchObject({ reservedPayouts: 5n * ATTO, stagedClaims: 5n * ATTO, totalBreaches: 1, solvent: true });
  });

  it("failing rounds fired in quick succession cannot stage: the outage must span real time", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "http502");
    for (let i = 0; i < 6; i++) {
      sim.advance(61); // 6 rounds in ~6 minutes
      sim.triggerProbe(BOT, id, BOND);
    }
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 6 });
    sim.advance(600); // now >= 15 minutes since the first failure
    expect(sim.triggerProbe(BOT, id, BOND).breachStaged).toBe(true);
  });

  it("a single failing round never stages a claim", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "down");
    sim.advance(3 * 3600);
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ verdict: "FAILING", breachStaged: false });
    expect(sim.get(id).status).toBe("ACTIVE");
    expect(sim.metrics().reservedPayouts).toBe(0n);
  });

  it("a recovery resets the streak", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    const h = hostOf(sim, id);
    sim.setEndpoint(h, "http502");
    for (let i = 0; i < 2; i++) {
      sim.advance(600);
      sim.triggerProbe(BOT, id, BOND);
    }
    sim.setEndpoint(h, "healthy");
    sim.advance(600);
    sim.triggerProbe(BOT, id, BOND);
    expect(sim.get(id)).toMatchObject({ consecutiveFailures: 0, outageStartedAt: 0 });
    sim.setEndpoint(h, "http502");
    sim.advance(600);
    sim.triggerProbe(BOT, id, BOND);
    sim.advance(600);
    expect(sim.triggerProbe(BOT, id, BOND).breachStaged).toBe(false); // only two failures since recovery
  });

  it("cover bought on a dead node never pays", () => {
    const sim = world();
    const id = mint(sim);
    sim.setEndpoint(hostOf(sim, id), "down");
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    for (let i = 0; i < 12; i++) {
      sim.triggerProbe(BOT, id, BOND);
      sim.advance(600);
    }
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", baselineOk: false });
  });

  it("a total outage seen by every provider is never attributed to the insured one", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    for (const n of NAMES) sim.setEndpoint(host(n), "down");
    for (let i = 0; i < 8; i++) {
      sim.advance(600);
      expect(sim.triggerProbe(BOT, id, BOND).verdict).toBe("INCONCLUSIVE");
    }
    expect(sim.get(id).status).toBe("ACTIVE");
    expect(sim.get(id).downtimeSecs).toBe(0);
  });

  it("enforces the grace period and one-shot settlement", () => {
    const sim = world();
    const id = mint(sim);
    revertsWith(() => sim.settleClaim(BOT, id, BOND), "[INVALID_STATE]");
    stage(sim, id);
    sim.advance(GRACE - 5);
    revertsWith(() => sim.settleClaim(BOT, id, BOND), "[TOO_SOON]");
    sim.advance(10);
    sim.settleClaim(BOT, id, BOND);
    revertsWith(() => sim.settleClaim(BOT, id, BOND), "[INVALID_STATE]");
  });

  it("a recovered endpoint dismisses the claim and forfeits the bond", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    sim.advance(GRACE + 1);
    sim.setEndpoint(hostOf(sim, id), "healthy");
    const tvl = sim.metrics().tvl;
    expect(sim.settleClaim(BOT, id, BOND).confirmed).toBe(false);
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    expect(sim.metrics()).toMatchObject({ reservedPayouts: 0n, lockedCoverage: 5n * ATTO, tvl: tvl + BOND });
  });

  it("an uncorroborated re-verification changes nothing", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    sim.advance(GRACE + 1);
    for (const h of refHosts(sim, id)) sim.setEndpoint(h, "down");
    revertsWith(() => sim.settleClaim(BOT, id, BOND), "[INCONCLUSIVE]");
    expect(sim.get(id).status).toBe("BREACH_PENDING");
  });

  it("unsettled claims lapse and release liquidity", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    revertsWith(() => sim.expirePolicy(id), "[INVALID_STATE]");
    sim.advance(GRACE + 14 * 86_400 + 1);
    expect(sim.expirePolicy(id)).toBe("LAPSED");
    expect(sim.metrics()).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n });
  });

  it("policies expire and free their exposure", () => {
    const sim = world();
    const id = mint(sim, OP, { durationBlocks: 400, coverage: 10n * ATTO });
    revertsWith(() => sim.expirePolicy(id), "[INVALID_STATE]");
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 400 * 12);
    expect(sim.expirePolicy(id)).toBe("EXPIRED");
    mint(sim, OP, { coverage: 10n * ATTO });
    mint(sim, OP, { coverage: 10n * ATTO });
  });
});

describe("vested payouts", () => {
  function confirmed(coverage = 5n * ATTO, ageDays = 0) {
    const sim = world();
    const id = mint(sim, OP, { coverage });
    if (ageDays > 0) sim.advance(ageDays * 86_400);
    stage(sim, id, "down");
    sim.advance(GRACE + 1);
    return { sim, id };
  }

  it("confirming a breach moves no funds: the payout starts vesting", () => {
    const { sim, id } = confirmed();
    const holderBefore = sim.balanceOf(OP);
    const tvl = sim.metrics().tvl;
    const r = sim.settleClaim(BOT, id, BOND);
    const expected = vestedPayout(5n * ATTO, sim.get(id).breachAt - sim.get(id).activeFrom); // frozen at staging
    expect(r).toMatchObject({ confirmed: true, payout: expected });
    expect(r.releasableFrom).toBe(sim.now + PAYOUT_COOLDOWN_SECS);
    expect(expected).toBeLessThan((5n * ATTO * 30n) / 100n);
    expect(sim.get(id)).toMatchObject({ status: "VESTING", payout: expected, released: 0n });
    expect(sim.balanceOf(OP)).toBe(holderBefore);
    expect(sim.metrics().tvl).toBe(tvl);
    expect(sim.metrics()).toMatchObject({ lockedCoverage: expected, reservedPayouts: expected, owedPayouts: expected, stagedClaims: 0n, activePolicies: 0, solvent: true });
  });

  it("nothing is releasable during the cooldown, then it streams linearly to the holder", () => {
    const { sim, id } = confirmed(10n * ATTO, 8);
    const { payout } = sim.settleClaim(BOT, id, BOND);
    expect(payout).toBe(10n * ATTO);
    revertsWith(() => sim.releasePayout(BOT, id), "[TOO_SOON]");
    sim.advance(PAYOUT_COOLDOWN_SECS - 5);
    revertsWith(() => sim.releasePayout(BOT, id), "[TOO_SOON]");

    sim.advance(5 + PAYOUT_VEST_SECS / 3);
    const first = sim.releasePayout("0xanyone", id); // permissionless; the HOLDER is paid
    expect(first.released).toBe(payout / 3n);
    expect(sim.transfers.at(-1)).toEqual({ to: OP, amount: first.released });
    expect(sim.get(id).status).toBe("VESTING");
    revertsWith(() => sim.releasePayout(BOT, id), "[TOO_SOON]");

    sim.advance(PAYOUT_VEST_SECS);
    const last = sim.releasePayout(BOT, id);
    expect(last.done).toBe(true);
    expect(first.released + last.released).toBe(payout);
    expect(sim.get(id).status).toBe("PAID");
    expect(sim.metrics()).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n, owedPayouts: 0n, totalPayouts: payout, solvent: true });
    revertsWith(() => sim.releasePayout(BOT, id), "[INVALID_STATE]");
  });

  it("is permissionless but cannot be redirected: only the holder is ever paid", () => {
    const { sim, id } = confirmed();
    sim.settleClaim(BOT, id, BOND);
    sim.advance(PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS);
    const before = sim.balanceOf(BOT);
    sim.releasePayout(BOT, id);
    expect(sim.balanceOf(BOT)).toBe(before);
    expect(sim.transfers.at(-1)!.to).toBe(OP);
  });

  it("pool accounting balances once everything is released", () => {
    const { sim, id } = confirmed(5n * ATTO, 8);
    sim.settleClaim(BOT, id, BOND);
    sim.advance(PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS + 1);
    sim.releasePayout(BOT, id);
    const m = sim.metrics();
    expect(m.tvl).toBe(100n * ATTO + m.totalPremiums + m.totalBondForfeits - m.totalPayouts);
    expect(m.totalPayouts).toBe(5n * ATTO);
  });
});

describe("moral hazard (adversarial)", () => {
  it("insuring an unauthenticated endpoint fails", () => {
    const sim = world();
    revertsWith(() => mint(sim, OP, { endpointId: "https://rpc.my-own-node.io" }), "[UNAUTHENTICATED_ENDPOINT]");
    revertsWith(() => sim.registerEndpoint(OP, { id: "mine", provider: "Mine", domain: "my-own-node.io", chainId: 1, url: "https://rpc.my-own-node.io" }), "[UNAUTHORIZED]");
  });

  it("a single uncorroborated report cannot trigger a payout", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "down");
    sim.advance(7 * 86_400);
    const r = sim.triggerProbe(BOT, id, BOND); // one report, however late
    expect(r.breachStaged).toBe(false);
    expect(sim.get(id).status).toBe("ACTIVE");
    revertsWith(() => sim.settleClaim(BOT, id, BOND), "[INVALID_STATE]");
    revertsWith(() => sim.releasePayout(BOT, id), "[INVALID_STATE]");
    expect(sim.metrics().totalPayouts).toBe(0n);
  });

  it("a holder cannot manufacture an outage by throttling its own endpoint", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "ratelimited");
    for (let i = 0; i < 10; i++) {
      sim.advance(900);
      sim.triggerProbe(BOT, id, BOND);
    }
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", downtimeSecs: 0 });
  });

  it("an authentic, corroborated, continuous outage pays out — after the cooldown, to the holder", () => {
    const sim = world();
    const id = mint(sim, OP, { coverage: 10n * ATTO });
    sim.advance(8 * 86_400);
    stage(sim, id, "down");
    expect(sim.get(id)).toMatchObject({ status: "BREACH_PENDING", baselineOk: true });
    expect(sim.get(id).consecutiveFailures).toBeGreaterThanOrEqual(3);
    sim.advance(GRACE + 1);
    expect(sim.settleClaim(BOT, id, BOND)).toMatchObject({ confirmed: true, payout: 10n * ATTO });
    const before = sim.balanceOf(OP);
    sim.advance(PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS);
    sim.releasePayout(BOT, id);
    expect(sim.balanceOf(OP)).toBe(before + 10n * ATTO);
    expect(sim.get(id).status).toBe("PAID");
    expect(sim.metrics().solvent).toBe(true);
  });
});

describe("solvency under simultaneous breach", () => {
  it.each([0, 8])("holds with policies aged %i days", (ageDays) => {
    const sim = world();
    const holders = ["0xa", "0xb", "0xc", "0xd"];
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(mint(sim, holders[Math.floor(i / 2)], { coverage: 10n * ATTO, endpointId: LATE[Math.floor(i / 2)] }));
    expect(sim.metrics().lockedCoverage).toBe(80n * ATTO);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1 + ageDays * 86_400);
    for (const id of ids) sim.triggerProbe(BOT, id, BOND);
    for (const n of LATE) sim.setEndpoint(host(n), "http502");
    failUntilStaged(sim, ids);
    expect(sim.metrics().reservedPayouts).toBe(80n * ATTO);
    sim.advance(GRACE + 1);
    let confirmedTotal = 0n;
    for (const id of ids) {
      for (;;) {
        try {
          confirmedTotal += sim.settleClaim(BOT, id, BOND).payout;
          break;
        } catch (e) {
          expect((e as ProtocolError).code).toBe("[VELOCITY_LIMIT]"); // the claim waits for the next epoch
          sim.advance(86_401);
        }
      }
      expect(sim.metrics().solvent).toBe(true);
      expect(sim.metrics().lockedCoverage <= sim.metrics().tvl).toBe(true);
    }
    expect(sim.metrics()).toMatchObject({ activePolicies: 0, owedPayouts: confirmedTotal, totalPayouts: 0n });
    sim.advance(PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS + 1);
    for (const id of ids) {
      sim.releasePayout(BOT, id);
      expect(sim.metrics().solvent).toBe(true);
    }
    const m = sim.metrics();
    expect(m).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n, owedPayouts: 0n, totalPayouts: confirmedTotal });
    if (ageDays > 0) expect(confirmedTotal).toBe(80n * ATTO);
    else expect(confirmedTotal).toBeLessThan((80n * ATTO * 30n) / 100n);
    expect(m.tvl).toBe(100n * ATTO + m.totalPremiums + m.totalBondForfeits - confirmedTotal);
  });
});

describe("demo world", () => {
  const sim = createDemoWorld(T0 + 1_000_000);
  it("is internally consistent", () => {
    const m = sim.metrics();
    expect(m.solvent).toBe(true);
    expect(m.tvl).toBeGreaterThan(0n);
    expect(m.totalPolicies).toBe(5);
    expect(m.listedEndpoints).toBe(5);
    expect(m.tvl).toBe(275n * ATTO + m.totalPremiums + m.totalBondForfeits - m.totalPayouts);
  });
  it("tells the story the dashboard shows", () => {
    const by = Object.fromEntries(sim.policies.map((p) => [p.host, p]));
    expect(by["sequencer.vertex-l2.com"].status).toBe("VESTING");
    expect(by["sequencer.vertex-l2.com"].released).toBeGreaterThan(0n);
    expect(by["sequencer.vertex-l2.com"].releasable).toBeGreaterThan(0n);
    expect(by["relay.nimbus-bridge.net"].status).toBe("BREACH_PENDING");
    expect(by["rpc.helios-node.io"]).toMatchObject({ status: "ACTIVE", holder: DEMO_ACCOUNT });
    expect(by["api.orbit-indexer.xyz"]).toMatchObject({ claimCount: 0, inconclusiveRounds: 3 }); // throttling is inconclusive, never a breach
    expect(sim.incidents.some((i) => i.kind === "BREACH_CONFIRMED_VESTING")).toBe(true);
    expect(sim.incidents.some((i) => i.kind === "PAYOUT_RELEASED")).toBe(true);
    expect(sim.incidents.filter((i) => i.kind === "ENDPOINT_LISTED")).toHaveLength(5);
    expect(sim.governor).toBe(DEMO_GOVERNOR);
    expect(sim.now).toBeLessThanOrEqual(T0 + 1_000_000 + 1);
  });
  it("is deterministic", () => {
    const again = createDemoWorld(T0 + 1_000_000);
    expect(again.metrics()).toEqual(sim.metrics());
    expect(again.incidents.length).toBe(sim.incidents.length);
  });
});

describe("hardening mirrors the contract", () => {
  it("freezes deposits while a claim is STAGED, so a staged breach cannot buy discounted shares", () => {
    const sim = world();
    const id = mint(sim, OP, { coverage: 10n * ATTO });
    stage(sim, id);
    expect(sim.metrics().reservedPayouts).toBe(10n * ATTO);
    const shares = sim.metrics().totalShares;
    revertsWith(() => sim.deposit("0xa", 50n * ATTO), "[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]");
    expect(sim.metrics().totalShares).toBe(shares);
    sim.advance(GRACE + 1);
    sim.setEndpoint(hostOf(sim, id), "healthy");
    sim.settleClaim(BOT, id, BOND); // dismissed
    const m = sim.metrics();
    expect(m.reservedPayouts).toBe(0n);
    expect(sim.deposit("0xa", 10n * ATTO)).toBe((10n * ATTO * m.totalShares) / m.netAssets); // reopened
  });

  it("deposits reopen once a breach is confirmed, priced net of the owed payout", () => {
    const sim = world();
    const id = mint(sim, OP, { coverage: 10n * ATTO });
    stage(sim, id, "down");
    sim.advance(GRACE + 1);
    sim.settleClaim(BOT, id, BOND);
    const m = sim.metrics();
    expect(m.stagedClaims).toBe(0n);
    expect(m.owedPayouts).toBeGreaterThan(0n);
    expect(m.netAssets).toBe(m.tvl - m.reservedPayouts);
    expect(sim.deposit("0xa", 10n * ATTO)).toBe((10n * ATTO * m.totalShares) / m.netAssets);
  });

  it("prices redemptions net of reserved payouts, so an early exit cannot dump a pending loss", () => {
    const sim = new SimProtocol(T0, DEFAULT_SIM_CONFIG, 7, GOV);
    for (const a of [UW, OP, BOT, "0xa"]) sim.fund(a, 10_000n * ATTO);
    for (const n of NAMES) sim.registerEndpoint(GOV, { id: n, provider: n, domain: `node-${n}.io`, chainId: 1, url: `https://${host(n)}` });
    sim.advance(LISTING_DELAY_SECS + 1);
    sim.deposit("0xa", 50n * ATTO);
    sim.deposit(UW, 50n * ATTO);
    const id = mint(sim, OP, { coverage: 10n * ATTO });
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1 + 8 * 86_400);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(hostOf(sim, id), "http502");
    failUntilStaged(sim, [id]);
    const m = sim.metrics();
    expect(m.netAssets).toBe(m.tvl - 10n * ATTO);
    const exitValue = sim.underwriter("0xa").value;
    expect(exitValue).toBe((sim.shares.get("0xa")! * m.netAssets) / m.totalShares);
    sim.withdraw("0xa", exitValue);
    const exited = sim.transfers.at(-1)!.amount;
    expect(exited).toBeLessThan(m.tvl / 2n - 4n * ATTO); // not ~half of gross TVL
    sim.advance(GRACE + 1);
    expect(sim.settleClaim(BOT, id, BOND).payout).toBe(10n * ATTO);
    const stayer = sim.underwriter(UW).value;
    const diff = stayer > exited ? stayer - exited : exited - stayer;
    expect(diff).toBeLessThanOrEqual(1_000_000_000n);
  });

  it("caps claim velocity per epoch yet always lets the first claim of an epoch through", () => {
    const sim = world();
    const holders = ["0xa", "0xb", "0xc", "0xd"];
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(mint(sim, holders[Math.floor(i / 2)], { coverage: 10n * ATTO, endpointId: LATE[Math.floor(i / 2)] }));
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1 + 8 * 86_400);
    for (const id of ids) sim.triggerProbe(BOT, id, BOND);
    for (const n of LATE) sim.setEndpoint(host(n), "http502");
    failUntilStaged(sim, ids);
    sim.advance(GRACE + 1);
    const tvl = sim.metrics().tvl;
    let paid = 0n;
    const settled = (id: number) => {
      try {
        paid += sim.settleClaim(BOT, id, BOND).payout;
        return true;
      } catch (e) {
        expect((e as ProtocolError).code).toBe("[VELOCITY_LIMIT]");
        return false;
      }
    };
    expect(ids.filter(settled)).toHaveLength(3);
    expect(paid).toBe(30n * ATTO);
    expect(paid <= (tvl * 3000n) / 10_000n).toBe(true);
    expect(sim.get(ids[3]).status).toBe("BREACH_PENDING"); // blocked claims stay staged
    let days = 0;
    while (ids.some((id) => sim.get(id).status === "BREACH_PENDING")) {
      sim.advance(86_401);
      days += 1;
      for (const id of ids) if (sim.get(id).status === "BREACH_PENDING") settled(id);
      expect(days).toBeLessThanOrEqual(8);
    }
    expect(sim.metrics().solvent).toBe(true);
    expect(sim.metrics().owedPayouts).toBe(80n * ATTO);
  });
});

// ---------------------------------------------------------------------------
// Audit regressions (PulseSLA-review findings 1-4): each is the audit's proof of
// concept, mirrored from tests/test_uptime_sla.py::TestAuditRegressions.
// ---------------------------------------------------------------------------
describe("audit regressions", () => {
  const dust = 2n * 10n ** 12n;
  const holderOf = (sim: SimProtocol, id: number) => sim.get(id);

  describe("P1: orphaned capital", () => {
    it("the last LP cannot burn every share behind a staged claim, and withdrawable is the exact boundary", () => {
      const sim = world();
      const id = mint(sim, OP, { coverage: 10n * ATTO });
      stage(sim, id);
      expect(sim.get(id).status).toBe("BREACH_PENDING");
      const pos = sim.underwriter(UW);
      revertsWith(() => sim.withdraw(UW, pos.value), "[INSUFFICIENT_LIQUIDITY]");
      revertsWith(() => sim.withdraw(UW, pos.withdrawable + 1n), "[INSUFFICIENT_LIQUIDITY]");
      sim.withdraw(UW, pos.withdrawable);
      expect(sim.totalShares).toBeGreaterThan(0n);
    });

    it("a 0.001 GEN depositor cannot capture the reserve a dismissed claim frees", () => {
      const sim = world();
      const id = mint(sim, OP, { coverage: 10n * ATTO });
      stage(sim, id);
      sim.withdraw(UW, sim.underwriter(UW).value - dust);
      sim.advance(GRACE + 1);
      for (const h of [hostOf(sim, id)]) sim.setEndpoint(h, "healthy");
      expect(sim.settleClaim(BOT, id, BOND).confirmed).toBe(false);
      const freed = sim.metrics().tvl;
      expect(freed).toBeGreaterThanOrEqual(10n * ATTO);
      sim.deposit("0xa", 10n ** 15n);
      expect(sim.underwriter("0xa").value).toBeLessThanOrEqual(10n ** 15n + 1n);
      expect(sim.underwriter(UW).value).toBeGreaterThanOrEqual(freed - 10n ** 15n - 1n);
    });

    it("a position cannot be shrunk to a dust sliver behind a reserve", () => {
      const sim = world();
      const id = mint(sim, OP, { coverage: 10n * ATTO });
      stage(sim, id);
      revertsWith(() => sim.withdraw(UW, sim.underwriter(UW).value - 1000n), "[INSUFFICIENT_LIQUIDITY]");
    });

    it("a full exit is allowed (and leaves nothing behind) once nothing is locked", () => {
      const sim = world();
      sim.withdraw(UW, sim.underwriter(UW).value);
      expect(sim.totalShares).toBe(0n);
      expect(sim.poolAssets).toBe(0n);
    });
  });

  describe("P1: probe gaps", () => {
    it("failures on separate days are never one outage", () => {
      const sim = world();
      const id = mint(sim, OP, { probeIntervalBlocks: 150 });
      const h = hostOf(sim, id);
      sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
      sim.setEndpoint(h, "healthy");
      expect(sim.triggerProbe(BOT, id, BOND).ok).toBe(true);
      for (let day = 0; day < 3; day++) {
        sim.advance(86_400);
        sim.setEndpoint(h, "http502");
        const r = sim.triggerProbe(BOT, id, BOND);
        expect(r).toMatchObject({ verdict: "FAILING", breachStaged: false, consecutiveFailures: 1 });
        sim.setEndpoint(h, "healthy");
      }
      expect(sim.get(id)).toMatchObject({ status: "ACTIVE", downtimeSecs: 3 * 1800 });
    });

    it("a streak survives a gap up to the limit and breaks one second beyond it", () => {
      const sim = world();
      const id = mint(sim, OP, { probeIntervalBlocks: 150 });
      const h = hostOf(sim, id);
      sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
      sim.setEndpoint(h, "healthy");
      sim.triggerProbe(BOT, id, BOND);
      sim.setEndpoint(h, "http502");
      sim.advance(1801);
      expect(sim.triggerProbe(BOT, id, BOND).consecutiveFailures).toBe(1);
      sim.advance(3600);
      expect(sim.triggerProbe(BOT, id, BOND).consecutiveFailures).toBe(2);
      sim.advance(3601);
      expect(sim.triggerProbe(BOT, id, BOND).consecutiveFailures).toBe(1);
    });
  });

  describe("P2: settlement delay and post-expiry observation", () => {
    it("waiting after expiry can neither inflate nor confirm a stale claim", () => {
      const sim = world();
      const cov = 10n * ATTO;
      const id = mint(sim, OP, { coverage: cov, durationBlocks: 500, minUptimeBps: 9900, probeIntervalBlocks: 25 });
      stage(sim, id);
      expect(sim.get(id).status).toBe("BREACH_PENDING");
      const first = vestedPayout(cov, holderOf(sim, id).breachAt - holderOf(sim, id).activeFrom);
      expect(first).toBeLessThan(cov);
      sim.setEndpoint(hostOf(sim, id), "healthy");
      sim.advance(7 * 86_400);
      sim.setEndpoint(hostOf(sim, id), "http502");
      revertsWith(() => sim.settleClaim(BOT, id, BOND), "[INVALID_STATE]");
      revertsWith(() => sim.triggerProbe(BOT, id, BOND), "[INVALID_STATE]");
      expect(sim.expirePolicy(id)).toBe("LAPSED");
      expect(sim.metrics().reservedPayouts).toBe(0n);
    });

    it("an in-term settlement delay does not raise the payout", () => {
      const sim = world();
      const cov = 10n * ATTO;
      const id = mint(sim, OP, { coverage: cov });
      stage(sim, id);
      const p = sim.get(id);
      const expected = vestedPayout(cov, p.breachAt - p.activeFrom);
      sim.advance(5 * 86_400);
      const r = sim.settleClaim(BOT, id, BOND);
      expect(r).toMatchObject({ confirmed: true, payout: expected });
      expect(expected).toBeLessThan(vestedPayout(cov, sim.now - p.activeFrom));
    });
  });

  describe("P2: unpayable terms", () => {
    it("rejects a term too short for the SLA and cadence, and accepts exactly the minimum", () => {
      const sim = world();
      revertsWith(() => mint(sim, OP, { durationBlocks: 300, minUptimeBps: 9000, probeIntervalBlocks: 150 }), "[INVALID_PARAMS]");
      revertsWith(() => mint(sim, OP, { durationBlocks: 300, probeIntervalBlocks: 7200 }), "[INVALID_PARAMS]");
      const need = minDurationBlocks(9000, 150, GRACE);
      revertsWith(() => mint(sim, OP, { durationBlocks: need - 1, minUptimeBps: 9000, probeIntervalBlocks: 150 }), "[INVALID_PARAMS]");
      expect(mint(sim, OP, { durationBlocks: need, minUptimeBps: 9000, probeIntervalBlocks: 150 })).toBeGreaterThan(0);
    });

    it.each([[9000, 150], [9500, 150], [9900, 25], [9990, 5], [9999, 60]])(
      "the minimum term for %i bps every %i blocks can actually be paid out",
      (uptime, interval) => {
        const sim = world();
        const id = mint(sim, OP, { durationBlocks: minDurationBlocks(uptime, interval, GRACE), minUptimeBps: uptime, probeIntervalBlocks: interval });
        const h = hostOf(sim, id);
        sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
        sim.setEndpoint(h, "healthy");
        expect(sim.triggerProbe(BOT, id, BOND).ok).toBe(true);
        sim.setEndpoint(h, "http502");
        let staged = false;
        for (let i = 0; i < 200 && !staged; i++) {
          sim.advance(interval * 12);
          staged = sim.triggerProbe(BOT, id, BOND).breachStaged;
        }
        expect(staged).toBe(true);
        sim.advance(GRACE);
        expect(sim.settleClaim(BOT, id, BOND).confirmed).toBe(true);
      },
    );
  });
});
