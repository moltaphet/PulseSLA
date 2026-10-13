import { describe, expect, it } from "vitest";
import { draftPolicy, DEFAULT_FORM, insurability, type FormContext, type PolicyFormState } from "@/lib/policyForm";
import { policyHealth, probeChecks, probeEligibility, probeSeries, releaseEligibility, settleEligibility } from "@/lib/policyState";
import { previewDeposit, previewWithdrawBurn, validateDeposit, validateWithdraw } from "@/lib/underwriting";
import { quotePremium } from "@/lib/pricing";
import type { Endpoint, Incident, Policy } from "@/lib/types";
import { ATTO } from "@/lib/units";

describe("underwriting helpers", () => {
  it("previews shares like the contract", () => {
    expect(previewDeposit(10n, 0n, 0n)).toBe(10n);
    expect(previewDeposit(50n * ATTO, 100n * ATTO + 1000n, 100n * ATTO)).toBe((50n * ATTO * 100n * ATTO) / (100n * ATTO + 1000n));
    expect(previewWithdrawBurn(10n, 30n, 100n)).toBe(34n); // ceil(1000/30)
    expect(previewWithdrawBurn(10n, 0n, 0n)).toBe(0n);
  });
  it("validates deposits", () => {
    expect(validateDeposit("", 5n)).toEqual({ amount: null, error: null });
    expect(validateDeposit("abc", null).error).toMatch(/valid amount/);
    expect(validateDeposit("0.0001", null).error).toMatch(/Minimum deposit/);
    expect(validateDeposit("6", 5n * ATTO).error).toMatch(/wallet balance/);
    expect(validateDeposit("5", 5n * ATTO)).toEqual({ amount: 5n * ATTO, error: null });
    expect(validateDeposit("5", null).amount).toBe(5n * ATTO);
  });
  it("validates withdrawals against position and locked liquidity", () => {
    expect(validateWithdraw("0", 10n * ATTO, 10n * ATTO).error).toBeTruthy();
    expect(validateWithdraw("11", 10n * ATTO, 10n * ATTO).error).toMatch(/position value/);
    expect(validateWithdraw("8", 10n * ATTO, 5n * ATTO).error).toMatch(/Only 5 GEN is withdrawable/);
    expect(validateWithdraw("4", 10n * ATTO, 5n * ATTO).amount).toBe(4n * ATTO);
  });
});

const NOW = 1_000_000;
const endpoint = (id: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id, provider: `Provider ${id}`, domain: `node-${id}.io`, url: `https://rpc.node-${id}.io`, host: `rpc.node-${id}.io`, apex: `node-${id}.io`, chainId: 1,
  attestation: "00", listedAt: 0, insurableFrom: 86_400, status: "LISTED", ...over,
});
const REGISTRY = ["alpha", "beta", "gamma", "delta", "epsilon"].map((n) => endpoint(n));

const ctx = (over: Partial<FormContext> = {}): FormContext => ({
  tvl: 100n * ATTO, lockedCoverage: 0n, policies: [], holder: "0xme", balance: 50n * ATTO, endpoints: REGISTRY, now: NOW, ...over,
});
const form = (over: Partial<PolicyFormState> = {}): PolicyFormState => ({ ...DEFAULT_FORM, endpointId: "alpha", coverage: "5", ...over });

describe("insurability", () => {
  it("mirrors the contract's gates", () => {
    expect(insurability(REGISTRY[0], REGISTRY, NOW)).toEqual({ state: "insurable" });
    expect(insurability(endpoint("alpha", { status: "DELISTED" }), REGISTRY, NOW)).toEqual({ state: "delisted" });
    expect(insurability(endpoint("alpha", { insurableFrom: NOW + 10 }), REGISTRY, NOW)).toEqual({ state: "activating", at: NOW + 10 });
    expect(insurability(REGISTRY[0], REGISTRY.slice(0, 3), NOW)).toEqual({ state: "no-references", have: 2 });
  });
  it("same-provider endpoints and fresh listings do not count as references", () => {
    const same = [REGISTRY[0], endpoint("alpha2", { apex: "node-alpha.io" }), REGISTRY[1], REGISTRY[2]];
    expect(insurability(REGISTRY[0], same, NOW)).toEqual({ state: "no-references", have: 2 });
    const fresh = [...REGISTRY.slice(0, 3), endpoint("delta", { listedAt: NOW - 10 })];
    expect(insurability(REGISTRY[0], fresh, NOW)).toEqual({ state: "no-references", have: 2 });
  });
  it("other chains are not references", () => {
    const mixed = [REGISTRY[0], endpoint("beta", { chainId: 137 }), REGISTRY[2], REGISTRY[3]];
    expect(insurability(REGISTRY[0], mixed, NOW)).toEqual({ state: "no-references", have: 2 });
  });
});

describe("draftPolicy", () => {
  it("builds contract args (a registry id, no URL) and the exact premium for a valid form", () => {
    const d = draftPolicy(form(), ctx());
    expect(d.valid).toBe(true);
    expect(d.args).toEqual({ endpointId: "alpha", coverage: 5n * ATTO, durationBlocks: 216_000, minUptimeBps: 9990, probeIntervalBlocks: 25 });
    expect(d.premium).toBe(quotePremium(5n * ATTO, 216_000, 9990));
    expect(d.annualRateBps).toBe(800);
  });
  it("silver is cheaper than gold", () => {
    expect(draftPolicy(form({ tier: "silver" }), ctx()).premium!).toBeLessThan(draftPolicy(form({ tier: "gold" }), ctx()).premium!);
    expect(draftPolicy(form({ tier: "silver" }), ctx()).args?.minUptimeBps).toBe(9900);
  });
  it("an empty form is invalid but shows no errors yet", () => {
    const d = draftPolicy(DEFAULT_FORM, ctx());
    expect(d.valid).toBe(false);
    expect(d.errors.endpointId).toBeUndefined();
  });
  it("only accepts endpoints from the authenticated registry", () => {
    for (const endpointId of ["https://rpc.my-own-node.io", "not-listed"]) {
      const d = draftPolicy(form({ endpointId }), ctx());
      expect(d.valid).toBe(false);
      expect(d.args).toBeNull();
      expect(d.errors.endpointId).toMatch(/authenticated registry/);
    }
  });
  it("refuses delisted, still-activating and reference-starved endpoints", () => {
    const delisted = REGISTRY.map((e) => (e.id === "alpha" ? { ...e, status: "DELISTED" as const } : e));
    expect(draftPolicy(form(), ctx({ endpoints: delisted })).errors.endpointId).toMatch(/delisted/);
    const young = REGISTRY.map((e) => (e.id === "alpha" ? { ...e, insurableFrom: NOW + 1 } : e));
    expect(draftPolicy(form(), ctx({ endpoints: young })).errors.endpointId).toMatch(/authentication delay/);
    expect(draftPolicy(form(), ctx({ endpoints: REGISTRY.slice(0, 3) })).errors.endpointId).toMatch(/reference providers/);
  });
  it.each([
    [{ days: "0" }, "days"],
    [{ days: "999" }, "days"],
    [{ intervalMinutes: "0" }, "intervalMinutes"],
    [{ coverage: "abc" }, "coverage"],
    [{ coverage: "0.0000001" }, "coverage"],
  ] as const)("flags %j", (over, field) => {
    const d = draftPolicy(form(over as Partial<PolicyFormState>), ctx());
    expect(d.valid).toBe(false);
    expect(d.errors[field]).toBeTruthy();
  });
  it("explains which exposure cap blocks the coverage", () => {
    expect(draftPolicy(form({ coverage: "11" }), ctx()).errors.coverage).toMatch(/at most 10 GEN.*per-policy cap/);
    expect(draftPolicy(form({ coverage: "5" }), ctx({ lockedCoverage: 78n * ATTO })).errors.coverage).toMatch(/utilization cap/);
    const live = { host: "rpc.node-alpha.io", holder: "0xother", coverage: 18n * ATTO, status: "ACTIVE" } as Policy;
    expect(draftPolicy(form({ coverage: "5" }), ctx({ policies: [live] })).errors.coverage).toMatch(/per-provider cap/);
    const mine = { host: "x.io", holder: "0xme", coverage: 19n * ATTO, status: "ACTIVE" } as Policy;
    expect(draftPolicy(form({ coverage: "5" }), ctx({ policies: [mine] })).errors.coverage).toMatch(/per-holder cap/);
  });
  it("blocks an unaffordable premium", () => {
    expect(draftPolicy(form(), ctx({ balance: 1n })).errors.coverage).toMatch(/balance/);
  });
  it("an empty pool has no capacity", () => {
    expect(draftPolicy(form(), ctx({ tvl: 0n })).valid).toBe(true); // limits unknown client-side; the contract is the authority
  });
});

const policy = (over: Partial<Policy> = {}): Policy => ({
  id: 1, holder: "0xa", endpointId: "alpha", endpointUrl: "https://x.io", host: "x.io", apex: "x.io", chainId: 1, minUptimeBps: 9990, probeInterval: 60,
  coverage: ATTO, premium: 1n, createdAt: 0, activeFrom: 100, expiresAt: 1000, status: "ACTIVE", samplesTotal: 0, samplesOk: 0, uptimeBps: 10000,
  inconclusiveRounds: 0, downtimeSecs: 0, consecutiveFailures: 0, outageStartedAt: 0, outageBlocks: 0, baselineOk: false, lastProbeAt: 0, lastBlock: 0,
  lastRefHead: 0, lastReason: "", lastOk: false, settleAt: 0, claimCount: 0, payout: 0n, released: 0n, releasable: 0n, vestStart: 0, ...over,
});

describe("policy state", () => {
  it("health", () => {
    expect(policyHealth(policy(), 50).label).toBe("Activating");
    expect(policyHealth(policy(), 150).label).toBe("Awaiting first probe");
    expect(policyHealth(policy({ lastProbeAt: 120, lastOk: true }), 150)).toMatchObject({ label: "Healthy", tone: "pulse" });
    expect(policyHealth(policy({ lastProbeAt: 120, consecutiveFailures: 1 }), 150)).toMatchObject({ label: "Degraded", tone: "warn" });
    expect(policyHealth(policy({ status: "BREACH_PENDING" }), 150)).toMatchObject({ label: "Breach staged", tone: "danger" });
    expect(policyHealth(policy({ status: "VESTING" }), 150)).toMatchObject({ label: "Payout vesting", tone: "danger" });
    expect(policyHealth(policy({ status: "PAID" }), 150).label).toBe("Claim paid");
    expect(policyHealth(policy({ status: "EXPIRED" }), 150).tone).toBe("muted");
  });
  it("probe eligibility mirrors the contract's gates", () => {
    expect(probeEligibility(policy(), 50)).toMatchObject({ can: false, reason: expect.stringContaining("activates") });
    expect(probeEligibility(policy(), 150)).toEqual({ can: true, reason: null });
    expect(probeEligibility(policy({ lastProbeAt: 140 }), 150).reason).toMatch(/Next probe allowed in 50s/);
    expect(probeEligibility(policy(), 1000).reason).toMatch(/ended/);
    expect(probeEligibility(policy({ status: "PAID" }), 150).can).toBe(false);
    expect(probeEligibility(policy({ status: "VESTING" }), 150).can).toBe(false);
  });
  it("settle eligibility", () => {
    expect(settleEligibility(policy(), 150).reason).toBe("No staged claim");
    expect(settleEligibility(policy({ status: "BREACH_PENDING", settleAt: 200 }), 150).reason).toMatch(/Grace period ends in 50s/);
    expect(settleEligibility(policy({ status: "BREACH_PENDING", settleAt: 200 }), 200).can).toBe(true);
  });
  it("release eligibility follows the cooldown and the vested amount", () => {
    const vesting = (over: Partial<Policy> = {}) => policy({ status: "VESTING", vestStart: 1000, payout: 10n, ...over });
    expect(releaseEligibility(policy(), 5000).reason).toBe("No vesting payout");
    expect(releaseEligibility(vesting(), 1000 + 3600).reason).toMatch(/Cooldown ends in/);
    expect(releaseEligibility(vesting({ releasable: 4n }), 1000 + 90_000)).toEqual({ can: true, reason: null });
    expect(releaseEligibility(vesting({ releasable: 0n, released: 10n }), 1000 + 90_000).reason).toMatch(/Nothing has vested/);
  });
});

const inc = (over: Partial<Incident>): Incident => ({ index: 0, time: 0, policyId: 1, kind: "PROBE", detail: "", by: "", ...over });

describe("probe series and checks", () => {
  it("filters, orders and maps corroborated observations with their block lag", () => {
    const series = probeSeries(
      [inc({ index: 2, time: 30, ok: false, verdict: "FAILING", reason: "HTTP_ERROR", status: 502 }),
        inc({ index: 1, time: 10, ok: true, verdict: "HEALTHY", status: 200, block: 95, refHead: 100 }),
        inc({ index: 3, time: 20, policyId: 2, ok: true }), inc({ index: 4, time: 5, kind: "POLICY_CREATED" }),
        inc({ index: 5, time: 40, kind: "PAYOUT_RELEASED" }), inc({ index: 6, time: 25, kind: "BREACH_CONFIRMED_VESTING", ok: false, verdict: "FAILING", block: -1, refHead: 120 })],
      1,
    );
    expect(series.map((p) => p.index)).toEqual([1, 6, 2]);
    expect(series[0]).toMatchObject({ ok: true, block: 95, refHead: 100, lagBlocks: 5, verdict: "HEALTHY" });
    expect(series[1].lagBlocks).toBeNull();
  });
  it("explains a corroborated 502", () => {
    const c = probeChecks(inc({ ok: false, verdict: "FAILING", reason: "HTTP_ERROR", status: 502, block: -1, refHead: 500, refsOk: 3, refsTotal: 4 }));
    expect(c.find((x) => x.id === "reference")).toMatchObject({ pass: true, observed: "3 of 4 healthy" });
    expect(c.find((x) => x.id === "status")).toMatchObject({ pass: false, observed: "502" });
    expect(c.find((x) => x.id === "block")?.pass).toBeNull();
    expect(c.at(-1)).toMatchObject({ id: "verdict", pass: false, observed: "http error" });
  });
  it("explains stale blocks and unreachable endpoints against the reference head", () => {
    const stale = probeChecks(inc({ ok: false, verdict: "FAILING", reason: "STALE_BLOCK", status: 200, block: 7, refHead: 700, refsOk: 4, refsTotal: 4 }));
    expect(stale.find((x) => x.id === "block")).toMatchObject({ pass: false, observed: "block 7 vs head 700 (stale)", expected: "within 50 blocks" });
    const down = probeChecks(inc({ ok: false, verdict: "FAILING", reason: "UNREACHABLE", status: 0, refsOk: 4, refsTotal: 4 }));
    expect(down.find((x) => x.id === "status")).toMatchObject({ pass: false, observed: "no response" });
  });
  it("an inconclusive round fails the baseline check and passes judgement on nothing", () => {
    const c = probeChecks(inc({ ok: false, verdict: "INCONCLUSIVE", reason: "NO_BASELINE", status: 0, refsOk: 1, refsTotal: 4 }));
    expect(c.find((x) => x.id === "reference")).toMatchObject({ pass: false, observed: "1 of 4 healthy" });
    expect(c.find((x) => x.id === "status")?.pass).toBeNull();
    expect(c.at(-1)).toMatchObject({ id: "verdict", pass: null });
  });
  it("non-observations have no checks", () => {
    expect(probeChecks(inc({ kind: "POLICY_CREATED" }))).toEqual([]);
  });
});
