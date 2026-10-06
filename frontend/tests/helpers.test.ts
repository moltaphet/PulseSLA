import { describe, expect, it } from "vitest";
import { draftPolicy, DEFAULT_FORM, type FormContext, type PolicyFormState } from "@/lib/policyForm";
import { policyHealth, probeChecks, probeEligibility, probeSeries, settleEligibility } from "@/lib/policyState";
import { previewDeposit, previewWithdrawBurn, validateDeposit, validateWithdraw } from "@/lib/underwriting";
import { quotePremium } from "@/lib/pricing";
import type { Incident, Policy } from "@/lib/types";
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

const ctx = (over: Partial<FormContext> = {}): FormContext => ({ tvl: 100n * ATTO, lockedCoverage: 0n, policies: [], holder: "0xme", balance: 50n * ATTO, ...over });
const form = (over: Partial<PolicyFormState> = {}): PolicyFormState => ({ ...DEFAULT_FORM, url: "https://rpc.node-alpha.io", coverage: "5", ...over });

describe("draftPolicy", () => {
  it("builds contract args and the exact premium for a valid form", () => {
    const d = draftPolicy(form(), ctx());
    expect(d.valid).toBe(true);
    expect(d.args).toEqual({
      endpointUrl: "https://rpc.node-alpha.io", maxLatencyMs: 500, coverage: 5n * ATTO, durationBlocks: 216_000, minUptimeBps: 9990,
      probeIntervalBlocks: 25, probeMode: "rpc",
    });
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
    expect(d.errors.url).toBeUndefined();
  });
  it.each([
    [{ url: "http://127.0.0.1:8545" }, "url"],
    [{ maxLatencyMs: "10" }, "maxLatencyMs"],
    [{ maxLatencyMs: "abc" }, "maxLatencyMs"],
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
    expect(draftPolicy(form({ coverage: "5" }), ctx({ policies: [live] })).errors.coverage).toMatch(/per-endpoint cap/);
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
  id: 1, holder: "0xa", endpointUrl: "https://x.io", host: "x.io", probeMode: "rpc", maxLatencyMs: 500, minUptimeBps: 9990, probeInterval: 60,
  coverage: ATTO, premium: 1n, createdAt: 0, activeFrom: 100, expiresAt: 1000, status: "ACTIVE", samplesTotal: 0, samplesOk: 0, uptimeBps: 10000,
  consecutiveFailures: 0, baselineOk: false, lastProbeAt: 0, lastBlock: 0, lastLatencyMs: 0, lastReason: "", lastOk: false, settleAt: 0,
  claimCount: 0, payout: 0n, ...over,
});

describe("policy state", () => {
  it("health", () => {
    expect(policyHealth(policy(), 50).label).toBe("Activating");
    expect(policyHealth(policy(), 150).label).toBe("Awaiting first probe");
    expect(policyHealth(policy({ lastProbeAt: 120, lastOk: true }), 150)).toMatchObject({ label: "Healthy", tone: "pulse" });
    expect(policyHealth(policy({ lastProbeAt: 120, consecutiveFailures: 1 }), 150)).toMatchObject({ label: "Degraded", tone: "warn" });
    expect(policyHealth(policy({ status: "BREACH_PENDING" }), 150)).toMatchObject({ label: "Breach confirmed", tone: "danger" });
    expect(policyHealth(policy({ status: "PAID" }), 150).label).toBe("Claim paid");
    expect(policyHealth(policy({ status: "EXPIRED" }), 150).tone).toBe("muted");
  });
  it("probe eligibility mirrors the contract's gates", () => {
    expect(probeEligibility(policy(), 50)).toMatchObject({ can: false, reason: expect.stringContaining("activates") });
    expect(probeEligibility(policy(), 150)).toEqual({ can: true, reason: null });
    expect(probeEligibility(policy({ lastProbeAt: 140 }), 150).reason).toMatch(/Next probe allowed in 50s/);
    expect(probeEligibility(policy(), 1000).reason).toMatch(/ended/);
    expect(probeEligibility(policy({ status: "PAID" }), 150).can).toBe(false);
  });
  it("settle eligibility", () => {
    expect(settleEligibility(policy(), 150).reason).toBe("No staged claim");
    expect(settleEligibility(policy({ status: "BREACH_PENDING", settleAt: 200 }), 150).reason).toMatch(/Grace period ends in 50s/);
    expect(settleEligibility(policy({ status: "BREACH_PENDING", settleAt: 200 }), 200).can).toBe(true);
  });
});

const inc = (over: Partial<Incident>): Incident => ({ index: 0, time: 0, policyId: 1, kind: "PROBE", detail: "", by: "", ...over });

describe("probe series and checks", () => {
  it("filters, orders and maps observations", () => {
    const series = probeSeries(
      [inc({ index: 2, time: 30, ok: false, latencyMs: 9, reason: "HTTP_ERROR", status: 502 }), inc({ index: 1, time: 10, ok: true, latencyMs: 80, status: 200, block: 5 }),
        inc({ index: 3, time: 20, policyId: 2, ok: true }), inc({ index: 4, time: 5, kind: "POLICY_CREATED" }), inc({ index: 5, time: 40, kind: "BREACH_CONFIRMED" })],
      1,
    );
    expect(series.map((p) => p.index)).toEqual([1, 2]);
    expect(series[0]).toMatchObject({ latencyMs: 80, ok: true, block: 5 });
  });
  const p = policy();
  it("explains a 502", () => {
    const c = probeChecks(inc({ ok: false, reason: "HTTP_ERROR", status: 502, latencyMs: 40, block: -1 }), p);
    expect(c.find((x) => x.id === "status")).toMatchObject({ pass: false, observed: "502" });
    expect(c.find((x) => x.id === "latency")?.pass).toBe(true);
    expect(c.find((x) => x.id === "block")?.pass).toBeNull();
    expect(c.at(-1)).toMatchObject({ id: "verdict", pass: false, observed: "http error" });
  });
  it("explains high latency, stale blocks and unreachable endpoints", () => {
    expect(probeChecks(inc({ ok: false, reason: "HIGH_LATENCY", status: 200, latencyMs: 2400, block: 7 }), p).find((x) => x.id === "latency")).toMatchObject({ pass: false, expected: "≤ 500 ms" });
    expect(probeChecks(inc({ ok: false, reason: "STALE_BLOCK", status: 200, latencyMs: 50, block: 7 }), p).find((x) => x.id === "block")).toMatchObject({ pass: false, observed: "block 7 (frozen)" });
    const down = probeChecks(inc({ ok: false, reason: "UNREACHABLE", status: 0, latencyMs: 3000 }), p);
    expect(down.find((x) => x.id === "status")).toMatchObject({ pass: false, observed: "no response" });
  });
  it("http-mode policies have no block check; non-observations have no checks", () => {
    expect(probeChecks(inc({ ok: true, reason: "OK", status: 200, latencyMs: 10 }), policy({ probeMode: "http" })).some((c) => c.id === "block")).toBe(false);
    expect(probeChecks(inc({ kind: "POLICY_CREATED" }), p)).toEqual([]);
  });
});
