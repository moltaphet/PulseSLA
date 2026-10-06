import { CHAIN_ID, RPC_URL } from "../config";
import { parseIncidents, parsePolicies, parsePolicy, parsePoolMetrics, parseUnderwriter, big } from "../parse";
import type {
  ConsensusVote, CreatePolicyArgs, Incident, Policy, PoolMetrics, TxReceipt, UnderwriterPosition,
} from "../types";
import type { ProtocolClient } from "./client";

/** The slice of the genlayer-js client this app uses (the SDK is loaded lazily: it is browser-only). */
interface SdkClient {
  readContract(a: { address: string; functionName: string; args?: unknown[]; jsonSafeReturn?: boolean }): Promise<unknown>;
  writeContract(a: { address: string; functionName: string; args?: unknown[]; value?: bigint; fees?: unknown }): Promise<string>;
  estimateTransactionFees(): Promise<{ distribution: unknown; messageAllocations?: unknown; feeValue: bigint }>;
  waitForTransactionReceipt(a: { hash: string; waitUntil?: string; interval?: number; retries?: number }): Promise<Record<string, unknown>>;
  getTransaction(a: { hash: string }): Promise<Record<string, unknown>>;
  getBalance(a: { address: string }): Promise<bigint>;
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const PAGE = 50;

/** Turn `consensus_data.votes` ({validator: "AGREE" | "DISAGREE" | ...}) into the roll call the inspector shows. */
export function parseVotes(tx: Record<string, unknown>): ConsensusVote[] | undefined {
  const consensus = (tx.consensus_data ?? tx.consensusData) as { votes?: Record<string, string> } | undefined;
  const votes = consensus?.votes;
  if (!votes || typeof votes !== "object") return undefined;
  const entries = Object.entries(votes);
  if (entries.length === 0) return undefined;
  return entries.map(([validator, vote], i) => ({
    validator,
    role: i === 0 ? ("leader" as const) : ("validator" as const),
    agree: /agree/i.test(vote) && !/dis/i.test(vote),
  }));
}

/** Best-effort failure text from a decided-but-reverted transaction. */
export function failureReason(receipt: Record<string, unknown>, tx: Record<string, unknown>): string | null {
  const exec = (receipt.txExecutionResultName ?? receipt.tx_execution_result_name) as string | undefined;
  const consensusName = receipt.result_name as string | undefined;
  if (exec && exec !== "FINISHED_WITH_RETURN") {
    const leader = ((tx.consensus_data as { leader_receipt?: { genvm_result?: { stderr?: string } }[] } | undefined)?.leader_receipt ?? [])[0];
    const stderr = leader?.genvm_result?.stderr;
    return stderr && /\[[A-Z_]+\]/.test(stderr) ? stderr : `Execution failed (${exec})`;
  }
  if (consensusName && consensusName !== "MAJORITY_AGREE") return `Validators did not reach consensus (${consensusName})`;
  return null;
}

export class LiveClient implements ProtocolClient {
  readonly mode = "live" as const;
  private reader: Promise<SdkClient> | null = null;

  constructor(
    private readonly address: string,
    private readonly provider: Eip1193 | null,
    private readonly rpcUrl: string = RPC_URL,
    private readonly chainId: number = CHAIN_ID,
  ) {}

  private async chain() {
    const sdk = await import("genlayer-js");
    const base = (sdk.chains as Record<string, Record<string, unknown>>).studioDevnet;
    return { sdk, chain: { ...base, id: this.chainId, rpcUrls: { default: { http: [this.rpcUrl] } } } };
  }

  private async readClient(): Promise<SdkClient> {
    this.reader ??= this.chain().then(({ sdk, chain }) => sdk.createClient({ chain: chain as never }) as unknown as SdkClient);
    return this.reader;
  }

  private async signer(sender: string): Promise<SdkClient> {
    if (!this.provider) throw new Error("No wallet connected");
    const { sdk, chain } = await this.chain();
    return sdk.createClient({ chain: chain as never, account: sender as never, provider: this.provider as never } as never) as unknown as SdkClient;
  }

  private async read(functionName: string, args: unknown[] = []): Promise<unknown> {
    const c = await this.readClient();
    return c.readContract({ address: this.address, functionName, args, jsonSafeReturn: true });
  }

  async getPoolMetrics(): Promise<PoolMetrics> { return parsePoolMetrics(await this.read("get_pool_metrics")); }
  async getUnderwriter(address: string): Promise<UnderwriterPosition> { return parseUnderwriter(await this.read("get_underwriter", [address.toLowerCase()])); }

  async listPolicies(): Promise<Policy[]> {
    const count = Number(big(await this.read("get_policy_count")));
    const out: Policy[] = [];
    for (let offset = 0; offset < count; offset += PAGE) out.push(...parsePolicies(await this.read("list_policies", [offset, PAGE])));
    return out;
  }

  async getIncidents(): Promise<Incident[]> {
    const count = Number(big(await this.read("get_incident_count")));
    const out: Incident[] = [];
    for (let offset = 0; offset < count; offset += 100) out.push(...parseIncidents(await this.read("get_incidents", [offset, 100])));
    return out;
  }

  async quotePremium(coverage: bigint, durationBlocks: number, minUptimeBps: number): Promise<bigint> {
    return big(await this.read("quote_premium", [coverage, durationBlocks, minUptimeBps]));
  }

  async getBalance(address: string): Promise<bigint | null> {
    try {
      return await (await this.readClient()).getBalance({ address });
    } catch {
      return null;
    }
  }

  private async write(sender: string, functionName: string, args: unknown[], summary: string, value = 0n): Promise<TxReceipt> {
    const c = await this.signer(sender);
    const est = await c.estimateTransactionFees();
    const hash = await c.writeContract({
      address: this.address, functionName, args, value,
      fees: { distribution: est.distribution, messageAllocations: est.messageAllocations, feeValue: est.feeValue },
    });
    const receipt = await c.waitForTransactionReceipt({ hash, waitUntil: "decided", interval: 4000, retries: 120 });
    const tx = await c.getTransaction({ hash });
    const failure = failureReason(receipt, tx);
    if (failure) throw new Error(failure);
    return { hash, summary, votes: parseVotes(tx) };
  }

  deposit(sender: string, amount: bigint) { return this.write(sender, "deposit_underwriting", [], "Deposit underwriting capital", amount); }
  withdraw(sender: string, amount: bigint) { return this.write(sender, "withdraw_underwriting", [amount], "Withdraw underwriting capital"); }
  createPolicy(sender: string, a: CreatePolicyArgs, premium: bigint) {
    return this.write(sender, "create_policy",
      [a.endpointUrl, a.maxLatencyMs, a.coverage, a.durationBlocks, a.minUptimeBps, a.probeIntervalBlocks, a.probeMode],
      "Mint SLA policy", premium);
  }

  async triggerProbe(sender: string, policyId: number, bond: bigint): Promise<TxReceipt> {
    const receipt = await this.write(sender, "trigger_probe", [policyId], `Probe policy #${policyId}`, bond);
    // The transaction's return value is awkward to decode across SDK versions; the chain state it wrote is not.
    const p = parsePolicy(await this.read("get_policy_status", [policyId]));
    return { ...receipt, outcome: { ok: p.lastOk, reason: p.lastReason, breachStaged: p.status === "BREACH_PENDING" } };
  }

  async settleClaim(sender: string, policyId: number, bond: bigint): Promise<TxReceipt> {
    const receipt = await this.write(sender, "settle_claim", [policyId], `Settle claim on policy #${policyId}`, bond);
    const p = parsePolicy(await this.read("get_policy_status", [policyId]));
    return { ...receipt, outcome: { paid: p.status === "PAID", payout: p.payout, reason: p.lastReason } };
  }

  expirePolicy(sender: string, policyId: number) { return this.write(sender, "expire_policy", [policyId], `Expire policy #${policyId}`); }
}
