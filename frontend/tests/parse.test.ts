import { describe, expect, it } from "vitest";
import { big, num, parseIncident, parseIncidents, parsePolicies, parsePolicy, parsePoolMetrics, parseUnderwriter, toRecord } from "@/lib/parse";

describe("coercion", () => {
  it("big", () => {
    expect(big("123")).toBe(123n);
    expect(big(5)).toBe(5n);
    expect(big(7n)).toBe(7n);
    expect(big("1.5")).toBe(0n);
    expect(big(undefined)).toBe(0n);
    expect(big(Number.NaN)).toBe(0n);
  });
  it("num", () => {
    expect(num("42")).toBe(42);
    expect(num(7n)).toBe(7);
    expect(num("")).toBe(0);
    expect(num("x")).toBe(0);
  });
  it("toRecord accepts objects, Maps (nested) and JSON strings", () => {
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
    expect(toRecord(new Map([["a", new Map([["b", 2]])]]))).toEqual({ a: { b: 2 } });
    expect(toRecord('{"a":1}')).toEqual({ a: 1 });
    expect(toRecord("not json")).toEqual({});
    expect(toRecord(null)).toEqual({});
  });
});

const POOL = {
  tvl: "100000000000000000000", total_shares: "100000000000000000000", share_price: "1000000000000000000",
  locked_coverage: "5000000000000000000", reserved_payouts: "0", free_liquidity: "95000000000000000000",
  utilization_bps: 500, apy_bps: 42, active_policies: 1, total_policies: 3, total_premiums: "1", total_payouts: "2",
  total_bond_forfeits: "3", total_probes: 9, total_breaches: 1, activation_delay: 3600, claim_grace: 600,
  probe_bond: "10000000000000000", solvent: true,
};

describe("parsePoolMetrics", () => {
  it("maps the contract's get_pool_metrics", () => {
    const m = parsePoolMetrics(POOL);
    expect(m).toMatchObject({ tvl: 100n * 10n ** 18n, lockedCoverage: 5n * 10n ** 18n, utilizationBps: 500, apyBps: 42, solvent: true, probeBond: 10n ** 16n });
  });
  it("accepts a Map and tolerates garbage", () => {
    expect(parsePoolMetrics(new Map(Object.entries(POOL))).totalProbes).toBe(9);
    expect(parsePoolMetrics(undefined)).toMatchObject({ tvl: 0n, solvent: false });
  });
  it("reads net assets and the velocity window, deriving net assets for older deployments", () => {
    const m = parsePoolMetrics({ ...POOL, net_assets: "90", epoch_paid: "5", epoch_ceiling: "30", max_epoch_payout_bps: 3000 });
    expect(m).toMatchObject({ netAssets: 90n, epochPaid: 5n, epochCeiling: 30n, maxEpochPayoutBps: 3000 });
    const old = parsePoolMetrics({ ...POOL, reserved_payouts: "4" });
    expect(old.netAssets).toBe(old.tvl - 4n);
  });
});

describe("parseUnderwriter", () => {
  it("maps string amounts", () => {
    expect(parseUnderwriter({ shares: "5", value: "6", withdrawable: "7" })).toEqual({ shares: 5n, value: 6n, withdrawable: 7n });
  });
});

const POLICY = {
  id: 1, holder: "0xABCDEF", endpoint_url: "https://rpc.node-alpha.io", host: "rpc.node-alpha.io", apex: "node-alpha.io", probe_mode: "http",
  max_latency_ms: 500, min_uptime_bps: 9990, probe_interval: 60, coverage: "5000000000000000000", premium: "15221",
  created_at: 10, active_from: 20, expires_at: 30, status: "BREACH_PENDING", samples_total: 4, samples_ok: 1, uptime_bps: 2500,
  consecutive_failures: 3, baseline_ok: true, last_probe_at: 25, last_block: 99, last_latency_ms: 40, last_reason: "HTTP_ERROR",
  last_ok: false, settle_at: 28, claim_count: 1, payout: "0",
};

describe("parsePolicy", () => {
  it("maps every field and lowercases the holder", () => {
    const p = parsePolicy(POLICY);
    expect(p).toMatchObject({
      id: 1, holder: "0xabcdef", apex: "node-alpha.io", probeMode: "http", coverage: 5n * 10n ** 18n, status: "BREACH_PENDING", baselineOk: true,
      lastReason: "HTTP_ERROR", settleAt: 28, claimCount: 1, consecutiveFailures: 3,
    });
  });
  it("falls back to the host when a policy has no apex", () => {
    expect(parsePolicy({ host: "rpc.node.io" }).apex).toBe("rpc.node.io");
  });
  it("defaults unknown status / mode safely", () => {
    expect(parsePolicy({ ...POLICY, status: "???", probe_mode: "x" })).toMatchObject({ status: "ACTIVE", probeMode: "rpc" });
  });
  it("parsePolicies handles non-arrays", () => {
    expect(parsePolicies([POLICY, POLICY])).toHaveLength(2);
    expect(parsePolicies(null)).toEqual([]);
  });
});

describe("parseIncident", () => {
  const probe = JSON.stringify({ i: 3, t: 100, policy_id: 2, kind: "PROBE", detail: "HTTP 502 returned", by: "0xBOT", ok: false, reason: "HTTP_ERROR", status: 502, latency_ms: 40, block: -1 });
  it("decodes JSON-string incidents with observations", () => {
    expect(parseIncident(probe)).toEqual({
      index: 3, time: 100, policyId: 2, kind: "PROBE", detail: "HTTP 502 returned", by: "0xbot", ok: false, reason: "HTTP_ERROR", status: 502, latencyMs: 40, block: -1,
    });
  });
  it("decodes lifecycle incidents without observations", () => {
    const inc = parseIncident(JSON.stringify({ i: 0, t: 1, policy_id: 1, kind: "POLICY_CREATED", detail: "x", by: "0xa" }))!;
    expect(inc.ok).toBeUndefined();
  });
  it("drops unknown kinds and junk", () => {
    expect(parseIncident(JSON.stringify({ kind: "NOPE" }))).toBeNull();
    expect(parseIncident("garbage")).toBeNull();
    expect(parseIncidents([probe, "garbage", probe])).toHaveLength(2);
    expect(parseIncidents(undefined)).toEqual([]);
  });
});
