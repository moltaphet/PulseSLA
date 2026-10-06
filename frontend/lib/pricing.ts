/**
 * Client-side mirror of the contract's pricing, caps and endpoint rules
 * (contracts/uptime_sla.py). The contract is the authority; these functions
 * exist so the UI can preview exactly what the chain will charge or reject.
 * lib/__fixtures__/premium-parity.json is generated from the contract and
 * asserted against `quotePremium` in the test suite.
 */
import { BLOCK_SECONDS, BPS, YEAR_SECONDS } from "./units";
import type { Policy } from "./types";

export const RATE_GOLD_BPS = 800n;
export const RATE_SILVER_BPS = 400n;
export const RATE_BRONZE_BPS = 200n;
export const MIN_PREMIUM_BPS = 10n;

export const LIMITS = {
  minLatencyMs: 50,
  maxLatencyMs: 30_000,
  minUptimeBps: 9000,
  maxUptimeBps: 9999,
  minDurationBlocks: 300,
  maxDurationBlocks: 2_628_000,
  minIntervalBlocks: 5,
  maxIntervalBlocks: 7200,
  minCoverage: 10n ** 15n,
  minDeposit: 10n ** 15n,
} as const;

export const CAPS_BPS = { policy: 1000n, host: 2000n, holder: 2000n, utilization: 8000n } as const;

export const BREACH_CONSECUTIVE = 3;
export const PAYOUT_FLOOR_BPS = 2500n;
export const PAYOUT_RAMP_SECONDS = 7 * 86_400;

export interface SlaTier {
  id: "gold" | "silver";
  label: string;
  uptimeBps: number;
  uptimeLabel: string;
  rateBps: bigint;
  blurb: string;
}

export const SLA_TIERS: readonly SlaTier[] = [
  { id: "gold", label: "Gold", uptimeBps: 9990, uptimeLabel: "99.9%", rateBps: RATE_GOLD_BPS,
    blurb: "≤ 43 min downtime / month before a claim can stage" },
  { id: "silver", label: "Silver", uptimeBps: 9900, uptimeLabel: "99.0%", rateBps: RATE_SILVER_BPS,
    blurb: "≤ 7.3 h downtime / month before a claim can stage" },
];

export function rateBpsFor(minUptimeBps: number): bigint {
  if (minUptimeBps >= 9990) return RATE_GOLD_BPS;
  if (minUptimeBps >= 9900) return RATE_SILVER_BPS;
  return RATE_BRONZE_BPS;
}

/** Exact integer mirror of `_premium_for`. */
export function quotePremium(coverage: bigint, durationBlocks: number, minUptimeBps: number): bigint {
  const secs = BigInt(durationBlocks) * BigInt(BLOCK_SECONDS);
  const premium = (coverage * rateBpsFor(minUptimeBps) * secs) / (BPS * BigInt(YEAR_SECONDS));
  const floor = (coverage * MIN_PREMIUM_BPS) / BPS;
  return premium > floor ? premium : floor;
}

/** Premium as a percentage of coverage for the whole term, in bps. */
export function premiumRateBps(premium: bigint, coverage: bigint): number {
  return coverage === 0n ? 0 : Number((premium * BPS) / coverage);
}

/** Mirror of `_vested_payout`: young policies vest 25% of coverage, rising to 100% over 7 days. */
export function vestedPayout(coverage: bigint, ageSeconds: number): bigint {
  const age = Math.max(0, ageSeconds);
  if (age >= PAYOUT_RAMP_SECONDS) return coverage;
  const bps = PAYOUT_FLOOR_BPS + ((BPS - PAYOUT_FLOOR_BPS) * BigInt(age)) / BigInt(PAYOUT_RAMP_SECONDS);
  return (coverage * bps) / BPS;
}

export function hostnameOf(url: string): string {
  const m = /^https?:\/\/([^/?#]*)/i.exec(url.trim());
  if (!m) return "";
  let auth = m[1];
  const at = auth.lastIndexOf("@");
  if (at >= 0) auth = auth.slice(at + 1);
  if (auth.startsWith("[")) return "";
  return auth.replace(/:\d*$/, "").toLowerCase().replace(/\.$/, "");
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".nip.io", ".sslip.io", ".xip.io"];
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function ipv4Parts(host: string): number[] | null {
  const labels = host.split(".");
  if (labels.length !== 4) return null;
  const out: number[] = [];
  for (const l of labels) {
    if (!/^(0|[1-9]\d{0,2})$/.test(l)) return null;
    const n = Number(l);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function isGlobalIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** Mirror of `_is_safe_endpoint`. Returns a human error message, or null when the URL is acceptable. */
export function validateEndpointUrl(url: string): string | null {
  if (url === "") return "Enter the endpoint URL to insure";
  if (url !== url.trim()) return "Remove leading or trailing spaces";
  if (url.length > 512) return "URL is too long (512 characters max)";
  if (url.includes("\\")) return "Backslashes are not allowed";
  if (!/^https?:\/\//i.test(url)) return "Must start with http:// or https://";
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  if (authority.includes("@")) return "Credentials in the URL are not allowed";
  if (authority.startsWith("[") || (authority.match(/:/g) ?? []).length > 1) return "IPv6 hosts are not allowed";
  const portMatch = /:(\d*)$/.exec(authority);
  if (portMatch && (portMatch[1] === "" || Number(portMatch[1]) > 65535)) return "Invalid port";
  const host = hostnameOf(url);
  if (host === "") return "URL has no host";
  const labels = host.split(".");
  if (labels.every((l) => /^\d+$/.test(l))) {
    const ip = ipv4Parts(host);
    if (!ip) return "Invalid IP address";
    return isGlobalIpv4(ip) ? null : "Private and reserved IP addresses are not allowed";
  }
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return "Not a valid public hostname";
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld)) return "Not a valid public hostname";
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "Internal hostnames are not allowed";
  return null;
}

export interface ExposureInput {
  tvl: bigint;
  lockedCoverage: bigint;
  hostExposure: bigint;
  holderExposure: bigint;
}

export type CapName = "policy" | "utilization" | "host" | "holder";

export interface CoverageLimits {
  max: bigint;
  binding: CapName;
  caps: Record<CapName, bigint>;
}

const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** The largest coverage the contract will accept right now, and which cap binds. */
export function coverageLimits(x: ExposureInput): CoverageLimits {
  const caps: Record<CapName, bigint> = {
    policy: (x.tvl * CAPS_BPS.policy) / BPS,
    utilization: sub0((x.tvl * CAPS_BPS.utilization) / BPS, x.lockedCoverage),
    host: sub0((x.tvl * CAPS_BPS.host) / BPS, x.hostExposure),
    holder: sub0((x.tvl * CAPS_BPS.holder) / BPS, x.holderExposure),
  };
  let binding: CapName = "policy";
  for (const k of ["utilization", "host", "holder"] as const) if (caps[k] < caps[binding]) binding = k;
  return { max: caps[binding], binding, caps };
}

/** Coverage already live on `host` / held by `holder`, from the policy list. */
export function exposureFor(policies: readonly Policy[], host: string, holder: string): { host: bigint; holder: bigint } {
  let h = 0n;
  let o = 0n;
  const hl = holder.toLowerCase();
  for (const p of policies) {
    if (p.status !== "ACTIVE" && p.status !== "BREACH_PENDING") continue;
    if (p.host === host) h += p.coverage;
    if (p.holder.toLowerCase() === hl) o += p.coverage;
  }
  return { host: h, holder: o };
}

/** Annualised premium income over TVL, in bps (mirrors the pool's apy_bps). */
export function annualisedYieldBps(runRateAtto: bigint, tvl: bigint): number {
  return tvl === 0n ? 0 : Number((runRateAtto * BPS) / tvl);
}
