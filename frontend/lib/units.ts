/** Amount, time and address formatting. All on-chain amounts are atto-GEN bigints (value * 10^18). */

export const ATTO = 10n ** 18n;
export const BPS = 10_000n;
export const BLOCK_SECONDS = 12;
export const YEAR_SECONDS = 365 * 24 * 3600;
export const DAY_SECONDS = 86_400;

/** Parse a decimal GEN string ("12.5") to atto-GEN. Returns null for anything that is not a plain non-negative decimal with <= 18 fraction digits. */
export function parseGen(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{0,18})?$|^\.\d{1,18}$/.test(s)) return null;
  const [whole = "", frac = ""] = s.split(".");
  return BigInt(whole || "0") * ATTO + BigInt(frac.padEnd(18, "0") || "0");
}

function group(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format atto-GEN, truncating (never rounding up) to `digits` decimals. Non-zero dust renders as "<0.0001". */
export function formatGen(value: bigint, digits = 4): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const whole = v / ATTO;
  const frac = (v % ATTO).toString().padStart(18, "0").slice(0, digits);
  if (whole === 0n && v > 0n && /^0*$/.test(frac)) return `<0.${"0".repeat(Math.max(digits - 1, 0))}1`;
  const trimmed = frac.replace(/0+$/, "");
  const body = trimmed ? `${group(whole)}.${trimmed.padEnd(Math.min(2, digits), "0")}` : group(whole);
  return neg ? `-${body}` : body;
}

/** Basis points -> "99.90%". */
export function formatBps(bps: number | bigint, digits = 2): string {
  return `${(Number(bps) / 100).toFixed(digits)}%`;
}

export function blocksToSeconds(blocks: number): number {
  return blocks * BLOCK_SECONDS;
}

export function daysToBlocks(days: number): number {
  return Math.round((days * DAY_SECONDS) / BLOCK_SECONDS);
}

export function blocksToDays(blocks: number): number {
  return (blocks * BLOCK_SECONDS) / DAY_SECONDS;
}

/** 3725 -> "1h 2m", 90 -> "1m 30s", 400000 -> "4d 15h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return s % 60 > 0 ? `${m}m ${s % 60}s` : `${m}m`;
}

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function formatTime(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/** Relative age of `unix` against `now`, e.g. "3m ago". */
export function timeAgo(unix: number, now: number): string {
  return unix <= 0 ? "never" : `${formatDuration(now - unix)} ago`;
}
