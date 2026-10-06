import { describe, expect, it } from "vitest";
import {
  ATTO, blocksToDays, daysToBlocks, formatBps, formatDuration, formatGen, parseGen, shortAddress, timeAgo,
} from "@/lib/units";

describe("parseGen", () => {
  it.each([
    ["1", ATTO],
    ["0.5", ATTO / 2n],
    [".25", ATTO / 4n],
    ["12.000000000000000001", 12n * ATTO + 1n],
    ["  7  ", 7n * ATTO],
    ["0", 0n],
  ])("parses %s", (input, expected) => expect(parseGen(input)).toBe(expected));

  it.each(["", "abc", "-1", "1e3", "1.2.3", "1,5", "0.0000000000000000001", "1.", " "])("rejects %j", (input) => {
    // "1." is accepted as 1 GEN by design; everything else is rejected
    if (input === "1.") expect(parseGen(input)).toBe(ATTO);
    else expect(parseGen(input)).toBeNull();
  });
});

describe("formatGen", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatGen(0n)).toBe("0");
    expect(formatGen(ATTO)).toBe("1");
    expect(formatGen(1_234_567n * ATTO)).toBe("1,234,567");
    expect(formatGen(ATTO + ATTO / 2n)).toBe("1.50");
    expect(formatGen(12_345_678_900_000_000_000n)).toBe("12.3456");
  });
  it("truncates rather than rounds up", () => {
    expect(formatGen(ATTO - 1n)).toBe("0.9999");
  });
  it("labels non-zero dust", () => {
    expect(formatGen(5n)).toBe("<0.0001");
    expect(formatGen(5n, 2)).toBe("<0.01");
  });
  it("handles negatives", () => {
    expect(formatGen(-3n * ATTO)).toBe("-3");
  });
  it("round-trips exact values through parseGen", () => {
    expect(formatGen(parseGen("123.4567")!)).toBe("123.4567");
    expect(formatGen(parseGen("1000")!)).toBe("1,000");
    expect(formatGen(parseGen("0.5")!)).toBe("0.50");
  });
});

describe("misc formatting", () => {
  it("bps", () => {
    expect(formatBps(9990)).toBe("99.90%");
    expect(formatBps(10_000, 1)).toBe("100.0%");
  });
  it("blocks and days are inverse at 12s blocks", () => {
    expect(daysToBlocks(1)).toBe(7200);
    expect(blocksToDays(7200)).toBe(1);
    expect(daysToBlocks(365)).toBe(2_628_000);
  });
  it.each([
    [0, "0s"], [45, "45s"], [60, "1m"], [90, "1m 30s"], [3600, "1h"], [3725, "1h 2m"], [90_000, "1d 1h"], [86_400, "1d"],
  ])("formatDuration(%i) = %s", (s, out) => expect(formatDuration(s)).toBe(out));
  it("addresses and ages", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("0xabc")).toBe("0xabc");
    expect(timeAgo(0, 100)).toBe("never");
    expect(timeAgo(40, 100)).toBe("1m ago");
  });
});
