import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMode } from "@/lib/config";
import { errorMessage } from "@/lib/chain/client";
import { failureReason, LiveClient, parseVotes } from "@/lib/chain/live";
import { ATTO } from "@/lib/units";

const calls: { fn: string; arg: Record<string, unknown> }[] = [];
let receipt: Record<string, unknown> = { txExecutionResultName: "FINISHED_WITH_RETURN", result_name: "MAJORITY_AGREE" };
let tx: Record<string, unknown> = { consensus_data: { votes: { "0xv1": "AGREE", "0xv2": "AGREE", "0xv3": "DISAGREE" } } };
const reads: Record<string, unknown> = {};

const fakeClient = {
  readContract: vi.fn(async (a: Record<string, unknown>) => {
    calls.push({ fn: "readContract", arg: a });
    return reads[a.functionName as string];
  }),
  estimateTransactionFees: vi.fn(async () => ({ distribution: { d: 1 }, feeValue: 5n, messageAllocations: undefined })),
  writeContract: vi.fn(async (a: Record<string, unknown>) => {
    calls.push({ fn: "writeContract", arg: a });
    return "0xhash";
  }),
  waitForTransactionReceipt: vi.fn(async () => receipt),
  getTransaction: vi.fn(async () => tx),
  getBalance: vi.fn(async () => 42n),
};
const createClient = vi.fn((cfg: Record<string, unknown>) => {
  calls.push({ fn: "createClient", arg: cfg });
  return fakeClient;
});
vi.mock("genlayer-js", () => ({ createClient: (c: Record<string, unknown>) => createClient(c), chains: { studioDevnet: { id: 1, name: "x", rpcUrls: { default: { http: ["old"] } } } } }));

const provider = { request: vi.fn() };
const ADDR = "0x1111111111111111111111111111111111111111";
const ME = "0x2222222222222222222222222222222222222222";

beforeEach(() => {
  calls.length = 0;
  receipt = { txExecutionResultName: "FINISHED_WITH_RETURN", result_name: "MAJORITY_AGREE" };
  tx = { consensus_data: { votes: { "0xv1": "AGREE", "0xv2": "AGREE", "0xv3": "DISAGREE" } } };
  for (const k of Object.keys(reads)) delete reads[k];
  vi.clearAllMocks();
});

describe("resolveMode", () => {
  it("is live only with an address, and demo can be forced", () => {
    expect(resolveMode(null, undefined)).toBe("demo");
    expect(resolveMode(ADDR, undefined)).toBe("live");
    expect(resolveMode(ADDR, "demo")).toBe("demo");
  });
});

describe("LiveClient reads", () => {
  it("pins the RPC url and reads views JSON-safely", async () => {
    reads.get_pool_metrics = { tvl: "7", solvent: true };
    const c = new LiveClient(ADDR, null, "https://rpc.test/api");
    const m = await c.getPoolMetrics();
    expect(m.tvl).toBe(7n);
    expect(m.solvent).toBe(true);
    const cfg = calls.find((x) => x.fn === "createClient")!.arg as { chain: { rpcUrls: { default: { http: string[] } } } };
    expect(cfg.chain.rpcUrls.default.http).toEqual(["https://rpc.test/api"]);
    expect(calls.find((x) => x.fn === "readContract")!.arg).toMatchObject({ address: ADDR, functionName: "get_pool_metrics", jsonSafeReturn: true });
  });

  it("lower-cases the underwriter address", async () => {
    reads.get_underwriter = { shares: "1", value: "2", withdrawable: "3" };
    const pos = await new LiveClient(ADDR, null).getUnderwriter("0xABCDEF");
    expect(pos).toEqual({ shares: 1n, value: 2n, withdrawable: 3n });
    expect(calls.find((x) => x.fn === "readContract")!.arg.args).toEqual(["0xabcdef"]);
  });

  it("pages policies and incidents", async () => {
    reads.get_policy_count = 3;
    reads.list_policies = [{ id: 1 }, { id: 2 }, { id: 3 }];
    reads.get_incident_count = "2";
    reads.get_incidents = [JSON.stringify({ i: 0, t: 1, policy_id: 1, kind: "POLICY_CREATED", detail: "d", by: "0xa" }), "junk"];
    const c = new LiveClient(ADDR, null);
    expect((await c.listPolicies()).map((p) => p.id)).toEqual([1, 2, 3]);
    expect(await c.getIncidents()).toHaveLength(1);
    expect(calls.filter((x) => x.arg.functionName === "list_policies")).toHaveLength(1);
  });

  it("quotes through the chain and reads balances", async () => {
    reads.quote_premium = "12345";
    const c = new LiveClient(ADDR, null);
    expect(await c.quotePremium(ATTO, 300, 9990)).toBe(12345n);
    expect(await c.getBalance(ME)).toBe(42n);
    fakeClient.getBalance.mockRejectedValueOnce(new Error("rpc down"));
    expect(await c.getBalance(ME)).toBeNull();
  });
});

describe("LiveClient writes", () => {
  it("sends a payable deposit with fees derived from the fee policy and waits for consensus", async () => {
    const r = await new LiveClient(ADDR, provider).deposit(ME, 3n * ATTO);
    const w = calls.find((x) => x.fn === "writeContract")!.arg;
    expect(w).toMatchObject({ address: ADDR, functionName: "deposit_underwriting", args: [], value: 3n * ATTO, fees: { feeValue: 5n } });
    expect(fakeClient.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: "0xhash", waitUntil: "decided" }));
    expect(r.hash).toBe("0xhash");
    expect(r.votes).toHaveLength(3);
    const signer = calls.find((x) => x.fn === "createClient")!.arg;
    expect(signer).toMatchObject({ account: ME, provider });
  });

  it("encodes create_policy arguments in contract order", async () => {
    await new LiveClient(ADDR, provider).createPolicy(ME, {
      endpointUrl: "https://x.io", maxLatencyMs: 500, coverage: ATTO, durationBlocks: 7200, minUptimeBps: 9990, probeIntervalBlocks: 25, probeMode: "rpc",
    }, 99n);
    expect(calls.find((x) => x.fn === "writeContract")!.arg).toMatchObject({
      functionName: "create_policy", args: ["https://x.io", 500, ATTO, 7200, 9990, 25, "rpc"], value: 99n,
    });
  });

  it("refuses to write without a wallet", async () => {
    await expect(new LiveClient(ADDR, null).withdraw(ME, 1n)).rejects.toThrow(/No wallet/);
  });

  it("raises reverts and failed consensus as errors", async () => {
    receipt = { txExecutionResultName: "FINISHED_WITH_ERROR" };
    tx = { consensus_data: { leader_receipt: [{ genvm_result: { stderr: "UserError('[EXPOSURE_CAP] per-holder exposure cap reached')" } }] } };
    await expect(new LiveClient(ADDR, provider).deposit(ME, 1n)).rejects.toThrow(/\[EXPOSURE_CAP\]/);
    receipt = { txExecutionResultName: "FINISHED_WITH_RETURN", result_name: "DISAGREE" };
    await expect(new LiveClient(ADDR, provider).deposit(ME, 1n)).rejects.toThrow(/did not reach consensus/);
  });

  it("derives probe and settle outcomes from the chain state the transaction wrote", async () => {
    reads.get_policy_status = { id: 1, status: "BREACH_PENDING", last_ok: false, last_reason: "HTTP_ERROR", coverage: "5", payout: "0" };
    const c = new LiveClient(ADDR, provider);
    expect((await c.triggerProbe(ME, 1, 10n)).outcome).toEqual({ ok: false, reason: "HTTP_ERROR", breachStaged: true });
    reads.get_policy_status = { id: 1, status: "PAID", last_ok: false, last_reason: "UNREACHABLE", payout: "4" };
    expect((await c.settleClaim(ME, 1, 10n)).outcome).toMatchObject({ paid: true, payout: 4n, reason: "UNREACHABLE" });
  });
});

describe("response helpers", () => {
  it("parseVotes maps the consensus vote record", () => {
    expect(parseVotes({ consensus_data: { votes: { a: "AGREE", b: "DISAGREE", c: "agree", d: "TIMEOUT" } } })?.map((v) => v.agree)).toEqual([true, false, true, false]);
    expect(parseVotes({ consensus_data: { votes: {} } })).toBeUndefined();
    expect(parseVotes({})).toBeUndefined();
  });
  it("failureReason is null for a clean receipt", () => {
    expect(failureReason({ txExecutionResultName: "FINISHED_WITH_RETURN", result_name: "MAJORITY_AGREE" }, {})).toBeNull();
  });
  it("errorMessage extracts contract error codes", () => {
    expect(errorMessage(new Error("execution reverted: [INSUFFICIENT_LIQUIDITY] capital is locked"))).toBe("[INSUFFICIENT_LIQUIDITY] capital is locked");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("Transaction failed");
  });
});
