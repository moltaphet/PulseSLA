import { describe, expect, it } from "vitest";
import parity from "@/lib/__fixtures__/premium-parity.json";
import termParity from "@/lib/__fixtures__/min-duration-parity.json";
import {
  apexOf, coverageLimits, exposureFor, hostnameOf, minDurationBlocks, PAYOUT_COOLDOWN_SECS, PAYOUT_VEST_SECS, quotePremium, rateBpsFor, referencesFor, releasableBy,
  validateEndpointUrl, vestedPayout,
} from "@/lib/pricing";
import type { Endpoint, Policy } from "@/lib/types";
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
    id: 1, holder: "0xa", endpointId: "h", endpointUrl: "", host: "h.io", apex: "h.io", chainId: 1, minUptimeBps: 9990, probeInterval: 60,
    coverage: ATTO, premium: 0n, createdAt: 0, activeFrom: 0, expiresAt: 0, status: "ACTIVE", samplesTotal: 0, samplesOk: 0,
    uptimeBps: 10000, inconclusiveRounds: 0, downtimeSecs: 0, consecutiveFailures: 0, outageStartedAt: 0, outageBlocks: 0, baselineOk: false,
    lastProbeAt: 0, lastBlock: 0, lastRefHead: 0, lastReason: "", lastOk: false, breachAt: 0, settleAt: 0, claimCount: 0, payout: 0n, released: 0n,
    releasable: 0n, vestStart: 0, ...over,
  });
  it("counts only live policies, case-insensitively for holders", () => {
    const ps = [mk({}), mk({ id: 2, status: "BREACH_PENDING" }), mk({ id: 3, status: "PAID" }), mk({ id: 4, host: "other.io", holder: "0xB" })];
    expect(exposureFor(ps, "h.io", "0xA")).toEqual({ host: 2n * ATTO, holder: 2n * ATTO });
    expect(exposureFor(ps, "other.io", "0xb")).toEqual({ host: ATTO, holder: ATTO });
  });
});

describe("apexOf: parity with the contract's registrable-domain grouping", () => {
  it.each([
    ["rpc.node.io", "node.io"], ["a.b.c.node.io", "node.io"], ["node.io", "node.io"],
    ["rpc.example.co.uk", "example.co.uk"], ["example.co.uk", "example.co.uk"], ["a.b.example.com.au", "example.com.au"],
    ["my-node.vercel.app", "my-node.vercel.app"], ["x.my-node.vercel.app", "my-node.vercel.app"],
    ["tenant.github.io", "tenant.github.io"], ["8.8.8.8", "8.8.8.8"],
  ])("%s -> %s", (host, apex) => expect(apexOf(host)).toBe(apex));

  it("exposureFor groups subdomains", () => {
    const live = { host: "rpc1.node.io", holder: "0xa", coverage: 3n * ATTO, status: "ACTIVE" } as Policy;
    expect(exposureFor([live], "rpc2.node.io", "0xz").host).toBe(3n * ATTO);
    expect(exposureFor([live], "rpc.other.io", "0xz").host).toBe(0n);
  });
});

describe("releasableBy: parity with the contract's vesting schedule", () => {
  const payout = 1000n * ATTO;
  it("releases nothing during the cooldown, then streams linearly, then caps at the payout", () => {
    expect(releasableBy(payout, 100, 100)).toBe(0n);
    expect(releasableBy(payout, 100, 100 + PAYOUT_COOLDOWN_SECS)).toBe(0n);
    expect(releasableBy(payout, 100, 100 + PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS / 4)).toBe(payout / 4n);
    expect(releasableBy(payout, 100, 100 + PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS)).toBe(payout);
    expect(releasableBy(payout, 100, 10 ** 9)).toBe(payout);
  });
  it("rounds down like the contract's integer division", () => {
    expect(releasableBy(10n, 0, PAYOUT_COOLDOWN_SECS + 1)).toBe(0n);
    expect(releasableBy(PAYOUT_VEST_SECS === 259_200 ? 259_201n : 0n, 0, PAYOUT_COOLDOWN_SECS + 1)).toBe(1n);
  });
});

describe("referencesFor: parity with the contract's reference selection", () => {
  const ep = (id: string, over: Partial<Endpoint> = {}): Endpoint => ({
    id, provider: id, domain: `${id}.io`, url: `https://rpc.${id}.io`, host: `rpc.${id}.io`, apex: `${id}.io`, chainId: 1, attestation: "",
    listedAt: 0, insurableFrom: 0, status: "LISTED", ...over,
  });
  const now = 10 * 86_400;
  it("takes the first four aged, listed, distinct-provider endpoints on the chain, excluding the target's provider", () => {
    const all = [ep("a"), ep("a2", { apex: "a.io" }), ep("b"), ep("c", { status: "DELISTED" }), ep("d", { chainId: 137 }), ep("e"), ep("f"), ep("g"), ep("h")];
    expect(referencesFor(all[0], all, now).map((e) => e.id)).toEqual(["b", "e", "f", "g"]);
  });
  it("skips listings younger than the delay", () => {
    const all = [ep("a"), ep("b", { listedAt: now - 10 }), ep("c")];
    expect(referencesFor(all[0], all, now).map((e) => e.id)).toEqual(["c"]);
  });
});

describe("minDurationBlocks: parity with the contract's minimum insurable term", () => {
  it("has fixture rows", () => expect(termParity.length).toBeGreaterThan(100));
  it.each(termParity.map((r) => [r.claim_grace, r.uptime_bps, r.interval_blocks, r.min_blocks] as const))(
    "grace %i s, %i bps, every %i blocks -> %i blocks",
    (grace, uptime, interval, expected) => {
      expect(minDurationBlocks(uptime, interval, grace)).toBe(expected);
    },
  );
});
