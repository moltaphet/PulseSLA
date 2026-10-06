import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SIM_CONFIG, ProtocolError, SimProtocol } from "@/lib/sim/engine";
import { createDemoWorld, DEMO_ACCOUNT } from "@/lib/sim/seed";
import { quotePremium, vestedPayout } from "@/lib/pricing";
import type { CreatePolicyArgs } from "@/lib/types";
import { ATTO } from "@/lib/units";

const T0 = 1_800_000_000;
const BOND = DEFAULT_SIM_CONFIG.probeBond;
const GRACE = DEFAULT_SIM_CONFIG.claimGrace;
const UW = "0xuw";
const OP = "0xop";
const BOT = "0xbot";

const args = (over: Partial<CreatePolicyArgs> = {}): CreatePolicyArgs => ({
  endpointUrl: "https://rpc.node-alpha.io", maxLatencyMs: 500, coverage: 5n * ATTO, durationBlocks: 100_000,
  minUptimeBps: 9990, probeIntervalBlocks: 5, probeMode: "rpc", ...over,
});

function world(pool = 100n): SimProtocol {
  const sim = new SimProtocol(T0);
  for (const a of [UW, OP, BOT, "0xa", "0xb", "0xc", "0xd", "0xe"]) sim.fund(a, 10_000n * ATTO);
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

/** healthy baseline, then three failing probes in the given endpoint mode */
function stage(sim: SimProtocol, id: number, mode: "http502" | "down" | "slow" = "http502") {
  const host = sim.get(id).host;
  sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
  sim.setEndpoint(host, "healthy");
  expect(sim.triggerProbe(BOT, id, BOND).ok).toBe(true);
  sim.setEndpoint(host, mode);
  for (let i = 0; i < 3; i++) {
    sim.advance(61);
    sim.triggerProbe(BOT, id, BOND);
  }
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

describe("policy creation", () => {
  it("enforces parameter bounds", () => {
    const sim = world();
    const cases: Partial<CreatePolicyArgs>[] = [
      { maxLatencyMs: 49 }, { durationBlocks: 299 }, { minUptimeBps: 8999 }, { probeIntervalBlocks: 4 }, { coverage: 10n ** 15n - 1n },
      { endpointUrl: "http://127.0.0.1" },
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
  it("enforces every exposure cap", () => {
    const sim = world();
    revertsWith(() => mint(sim, OP, { coverage: 11n * ATTO }), "[EXPOSURE_CAP]"); // per policy
    mint(sim, "0xa", { coverage: 10n * ATTO });
    mint(sim, "0xb", { coverage: 10n * ATTO }); // host at 20%
    revertsWith(() => mint(sim, "0xc", { coverage: ATTO }), "[EXPOSURE_CAP]"); // per host
    mint(sim, "0xa", { coverage: 10n * ATTO, endpointUrl: "https://two.node.io" });
    revertsWith(() => mint(sim, "0xa", { coverage: ATTO, endpointUrl: "https://three.node.io" }), "[EXPOSURE_CAP]"); // per holder
  });
  it("caps total utilization at 80%", () => {
    const sim = world();
    const holders = ["0xa", "0xb", "0xc", "0xd", "0xe"];
    for (let i = 0; i < 8; i++) mint(sim, holders[Math.floor(i / 2)], { coverage: 10n * ATTO, endpointUrl: `https://host${Math.floor(i / 2)}.node.io` });
    expect(sim.metrics().utilizationBps).toBeLessThanOrEqual(8000);
    revertsWith(() => mint(sim, "0xe", { coverage: 5n * ATTO, endpointUrl: "https://host9.node.io" }), "[EXPOSURE_CAP]");
  });
  it("an empty pool writes no policies", () => {
    revertsWith(() => mint(world(0n)), "[EXPOSURE_CAP]");
  });
});

describe("probes", () => {
  let sim: SimProtocol;
  let id: number;
  beforeEach(() => {
    sim = world();
    id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
  });

  it("healthy probe records the baseline and forfeits the bond", () => {
    const tvl = sim.metrics().tvl;
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r.ok).toBe(true);
    expect(r.votes).toHaveLength(5);
    expect(sim.get(id)).toMatchObject({ baselineOk: true, samplesOk: 1, uptimeBps: 10_000 });
    expect(sim.metrics().tvl).toBe(tvl + BOND);
  });

  it.each([
    ["http502", "HTTP_ERROR", 502], ["http504", "HTTP_ERROR", 504], ["down", "UNREACHABLE", 0], ["slow", "HIGH_LATENCY", 200], ["badpayload", "BAD_PAYLOAD", 200],
  ] as const)("%s fails as %s and refunds the bond", (mode, reason, status) => {
    sim.setEndpoint(sim.get(id).host, mode);
    const tvl = sim.metrics().tvl;
    const r = sim.triggerProbe(BOT, id, BOND);
    expect(r).toMatchObject({ ok: false, reason, status });
    expect(sim.metrics().tvl).toBe(tvl);
    expect(sim.transfers.at(-1)).toEqual({ to: BOT, amount: BOND });
  });

  it("detects a frozen block height", () => {
    const host = sim.get(id).host;
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(host, "frozen");
    sim.advance(61);
    expect(sim.triggerProbe(BOT, id, BOND).reason).toBe("STALE_BLOCK");
  });

  it("enforces activation delay, interval and bond", () => {
    const fresh = mint(sim);
    revertsWith(() => sim.triggerProbe(BOT, fresh, BOND), "[TOO_SOON]");
    sim.triggerProbe(BOT, id, BOND);
    revertsWith(() => sim.triggerProbe(BOT, id, BOND), "[TOO_SOON]");
    sim.advance(61);
    revertsWith(() => sim.triggerProbe(BOT, id, BOND - 1n), "[EXPECTED]");
  });

  it("every probe round has a validator quorum", () => {
    for (let i = 0; i < 30; i++) {
      const r = sim.triggerProbe(BOT, id, BOND);
      expect(r.votes.filter((v) => v.agree).length).toBeGreaterThanOrEqual(3);
      sim.advance(61);
    }
  });
});

describe("staged claims", () => {
  it("three consecutive failures after a healthy baseline stage a claim", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    const p = sim.get(id);
    expect(p.status).toBe("BREACH_PENDING");
    expect(p.settleAt).toBe(sim.now + GRACE);
    expect(sim.metrics()).toMatchObject({ reservedPayouts: 5n * ATTO, totalBreaches: 1, solvent: true });
  });

  it("cover bought on a dead node never pays", () => {
    const sim = world();
    const id = mint(sim);
    sim.setEndpoint(sim.get(id).host, "down");
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1);
    for (let i = 0; i < 12; i++) {
      sim.triggerProbe(BOT, id, BOND);
      sim.advance(61);
    }
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", baselineOk: false });
  });

  it("pays the holder a vested amount after the grace period", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id, "down");
    sim.advance(GRACE + 1);
    const tvl = sim.metrics().tvl;
    const holderBefore = sim.balanceOf(OP);
    const r = sim.settleClaim("0xa", id, BOND);
    const expected = vestedPayout(5n * ATTO, sim.now - sim.get(id).activeFrom);
    expect(r).toMatchObject({ paid: true, payout: expected });
    expect(expected).toBeLessThan((5n * ATTO * 30n) / 100n);
    expect(sim.balanceOf(OP)).toBe(holderBefore + expected);
    expect(sim.metrics().tvl).toBe(tvl - expected);
    expect(sim.get(id).status).toBe("PAID");
    expect(sim.metrics()).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n, activePolicies: 0 });
  });

  it("aged policies pay full coverage", () => {
    const sim = world();
    const id = mint(sim);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1 + 8 * 86_400);
    sim.triggerProbe(BOT, id, BOND);
    sim.setEndpoint(sim.get(id).host, "http504");
    for (let i = 0; i < 3; i++) {
      sim.advance(61);
      sim.triggerProbe(BOT, id, BOND);
    }
    sim.advance(GRACE + 1);
    expect(sim.settleClaim(BOT, id, BOND).payout).toBe(5n * ATTO);
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
    sim.setEndpoint(sim.get(id).host, "healthy");
    const tvl = sim.metrics().tvl;
    expect(sim.settleClaim(BOT, id, BOND).paid).toBe(false);
    expect(sim.get(id)).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    expect(sim.metrics()).toMatchObject({ reservedPayouts: 0n, lockedCoverage: 5n * ATTO, tvl: tvl + BOND });
  });

  it("unsettled claims lapse and release liquidity", () => {
    const sim = world();
    const id = mint(sim);
    stage(sim, id);
    revertsWith(() => sim.expirePolicy(id), "[INVALID_STATE]");
    sim.advance(GRACE + 7 * 86_400 + 1);
    expect(sim.expirePolicy(id)).toBe("LAPSED");
    expect(sim.metrics()).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n });
  });

  it("policies expire and free their exposure", () => {
    const sim = world();
    const id = mint(sim, OP, { durationBlocks: 300, coverage: 10n * ATTO });
    revertsWith(() => sim.expirePolicy(id), "[INVALID_STATE]");
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 300 * 12);
    expect(sim.expirePolicy(id)).toBe("EXPIRED");
    mint(sim, OP, { coverage: 10n * ATTO });
    mint(sim, OP, { coverage: 10n * ATTO });
  });
});

describe("solvency under simultaneous breach", () => {
  it.each([0, 8])("holds with policies aged %i days", (ageDays) => {
    const sim = world();
    const holders = ["0xa", "0xb", "0xc", "0xd"];
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(mint(sim, holders[Math.floor(i / 2)], { coverage: 10n * ATTO, endpointUrl: `https://host${Math.floor(i / 2)}.node.io` }));
    expect(sim.metrics().lockedCoverage).toBe(80n * ATTO);
    sim.advance(DEFAULT_SIM_CONFIG.activationDelay + 1 + ageDays * 86_400);
    for (const id of ids) sim.triggerProbe(BOT, id, BOND);
    for (const id of ids) sim.setEndpoint(sim.get(id).host, "http502");
    for (let r = 0; r < 3; r++) {
      sim.advance(61);
      for (const id of ids) sim.triggerProbe(BOT, id, BOND);
    }
    expect(ids.every((id) => sim.get(id).status === "BREACH_PENDING")).toBe(true);
    expect(sim.metrics().reservedPayouts).toBe(80n * ATTO);
    sim.advance(GRACE + 1);
    let paid = 0n;
    for (const id of ids) {
      paid += sim.settleClaim(BOT, id, BOND).payout;
      expect(sim.metrics().solvent).toBe(true);
      expect(sim.metrics().lockedCoverage <= sim.metrics().tvl).toBe(true);
    }
    const m = sim.metrics();
    expect(m).toMatchObject({ lockedCoverage: 0n, reservedPayouts: 0n, activePolicies: 0, totalPayouts: paid });
    if (ageDays > 0) expect(paid).toBe(80n * ATTO);
    else expect(paid).toBeLessThan((80n * ATTO * 30n) / 100n);
    expect(m.tvl).toBe(100n * ATTO + m.totalPremiums + m.totalBondForfeits - paid);
  });
});

describe("demo world", () => {
  const sim = createDemoWorld(T0 + 1_000_000);
  it("is internally consistent", () => {
    const m = sim.metrics();
    expect(m.solvent).toBe(true);
    expect(m.tvl).toBeGreaterThan(0n);
    expect(m.totalPolicies).toBe(5);
    expect(m.tvl).toBe(275n * ATTO + m.totalPremiums + m.totalBondForfeits - m.totalPayouts);
  });
  it("tells the story the dashboard shows", () => {
    const by = Object.fromEntries(sim.policies.map((p) => [p.host, p]));
    expect(by["sequencer.vertex-l2.com"].status).toBe("PAID");
    expect(by["relay.nimbus-bridge.net"].status).toBe("BREACH_PENDING");
    expect(by["rpc.helios-node.io"]).toMatchObject({ status: "ACTIVE", holder: DEMO_ACCOUNT });
    expect(by["api.orbit-indexer.xyz"].claimCount).toBe(0); // a near-miss that never staged
    expect(sim.incidents.some((i) => i.kind === "PAYOUT")).toBe(true);
    expect(sim.now).toBeLessThanOrEqual(T0 + 1_000_000 + 1);
  });
  it("is deterministic", () => {
    const again = createDemoWorld(T0 + 1_000_000);
    expect(again.metrics()).toEqual(sim.metrics());
    expect(again.incidents.length).toBe(sim.incidents.length);
  });
});
