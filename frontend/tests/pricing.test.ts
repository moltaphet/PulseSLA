import { describe, expect, it } from "vitest";
import parity from "@/lib/__fixtures__/premium-parity.json";
import {
  coverageLimits, exposureFor, hostnameOf, quotePremium, rateBpsFor, validateEndpointUrl, vestedPayout,
} from "@/lib/pricing";
import type { Policy } from "@/lib/types";
import { ATTO } from "@/lib/units";

describe("quotePremium: parity with the contract", () => {
  it("has fixture rows", () => expect(parity.length).toBeGreaterThan(100));
  it.each(parity.map((r) => [r.coverage, r.blocks, r.uptime_bps, r.premium] as const))(
    "coverage %s, %i blocks, %i bps",
    (coverage, blocks, uptime, premium) => {
      expect(quotePremium(BigInt(coverage), blocks, uptime)).toBe(BigInt(premium));
    },
  );
});

describe("tiers", () => {
  it("maps uptime to annual rate", () => {
    expect(rateBpsFor(9999)).toBe(800n);
    expect(rateBpsFor(9990)).toBe(800n);
    expect(rateBpsFor(9989)).toBe(400n);
    expect(rateBpsFor(9900)).toBe(400n);
    expect(rateBpsFor(9899)).toBe(200n);
  });
  it("a full year of Gold costs 8% of coverage", () => {
    expect(quotePremium(10n * ATTO, 2_628_000, 9990)).toBe((10n * ATTO * 800n) / 10_000n);
  });
  it("applies the 0.10% floor", () => {
    expect(quotePremium(10n ** 15n, 300, 9500)).toBe((10n ** 15n * 10n) / 10_000n);
  });
});

describe("vestedPayout", () => {
  it("vests from 25% to 100% over 7 days", () => {
    const cov = 100n * ATTO;
    expect(vestedPayout(cov, 0)).toBe(25n * ATTO);
    expect(vestedPayout(cov, -50)).toBe(25n * ATTO);
    expect(vestedPayout(cov, 7 * 86_400)).toBe(cov);
    expect(vestedPayout(cov, 30 * 86_400)).toBe(cov);
    const mid = vestedPayout(cov, 3.5 * 86_400);
    expect(mid > 25n * ATTO && mid < cov).toBe(true);
    expect(mid).toBe((cov * 6250n) / 10_000n);
  });
});

// The same expectations as the contract suite's BAD_URLS / accepted lists.
const BAD = [
  "http://localhost:8545", "https://localhost", "http://127.0.0.1:8545", "http://10.0.0.5/rpc", "http://192.168.1.1",
  "http://172.16.0.9", "http://169.254.169.254/latest/meta-data", "https://user:pw@rpc.example.com", "http://0x7f000001",
  "http://2130706433", "http://127.1", "ftp://rpc.example.com", "https://rpc.internal", "https://box.local",
  "https://10.0.0.1.nip.io", "http://[::1]:8545/", "https://rpc.example.com\\@127.0.0.1", " https://rpc.example.com", "",
];
const GOOD = ["https://eth-mainnet.g.alchemy.com/v2/key", "http://8.8.8.8:8545", "https://RPC.Example.COM/path?x=1", "https://rpc.node-alpha.io"];

describe("validateEndpointUrl: parity with the contract's SSRF guard", () => {
  it.each(BAD)("rejects %j", (u) => expect(validateEndpointUrl(u)).not.toBeNull());
  it.each(GOOD)("accepts %s", (u) => expect(validateEndpointUrl(u)).toBeNull());
  it("extracts the lowercase host", () => {
    expect(hostnameOf("https://RPC.Example.COM:8545/x")).toBe("rpc.example.com");
    expect(hostnameOf("nope")).toBe("");
  });
  it("rejects bad ports and overlong urls", () => {
    expect(validateEndpointUrl("https://rpc.example.com:99999")).toMatch(/port/i);
    expect(validateEndpointUrl("https://rpc.example.com/" + "a".repeat(600))).toMatch(/long/i);
  });
});

describe("coverageLimits", () => {
  const tvl = 100n * ATTO;
  it("is bounded by the per-policy cap on an empty pool", () => {
    const l = coverageLimits({ tvl, lockedCoverage: 0n, hostExposure: 0n, holderExposure: 0n });
    expect(l.max).toBe(10n * ATTO);
    expect(l.binding).toBe("policy");
  });
  it("reports whichever cap binds first", () => {
    expect(coverageLimits({ tvl, lockedCoverage: 75n * ATTO, hostExposure: 0n, holderExposure: 0n })).toMatchObject({ max: 5n * ATTO, binding: "utilization" });
    expect(coverageLimits({ tvl, lockedCoverage: 0n, hostExposure: 18n * ATTO, holderExposure: 0n })).toMatchObject({ max: 2n * ATTO, binding: "host" });
    expect(coverageLimits({ tvl, lockedCoverage: 0n, hostExposure: 0n, holderExposure: 19n * ATTO })).toMatchObject({ max: ATTO, binding: "holder" });
  });
  it("never goes negative", () => {
    expect(coverageLimits({ tvl, lockedCoverage: 95n * ATTO, hostExposure: 0n, holderExposure: 0n }).max).toBe(0n);
  });
});

describe("exposureFor", () => {
  const mk = (over: Partial<Policy>): Policy => ({
    id: 1, holder: "0xa", endpointUrl: "", host: "h.io", probeMode: "rpc", maxLatencyMs: 500, minUptimeBps: 9990, probeInterval: 60,
    coverage: ATTO, premium: 0n, createdAt: 0, activeFrom: 0, expiresAt: 0, status: "ACTIVE", samplesTotal: 0, samplesOk: 0,
    uptimeBps: 10000, consecutiveFailures: 0, baselineOk: false, lastProbeAt: 0, lastBlock: 0, lastLatencyMs: 0, lastReason: "",
    lastOk: false, settleAt: 0, claimCount: 0, payout: 0n, ...over,
  });
  it("counts only live policies, case-insensitively for holders", () => {
    const ps = [mk({}), mk({ id: 2, status: "BREACH_PENDING" }), mk({ id: 3, status: "PAID" }), mk({ id: 4, host: "other.io", holder: "0xB" })];
    expect(exposureFor(ps, "h.io", "0xA")).toEqual({ host: 2n * ATTO, holder: 2n * ATTO });
    expect(exposureFor(ps, "other.io", "0xb")).toEqual({ host: ATTO, holder: ATTO });
  });
});
