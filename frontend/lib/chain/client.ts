import type {
  CreatePolicyArgs, Incident, Policy, PoolMetrics, TxReceipt, UnderwriterPosition,
} from "../types";

export type ClientMode = "demo" | "live";

/** Everything the dashboard needs from the protocol. Live and demo clients are interchangeable. */
export interface ProtocolClient {
  readonly mode: ClientMode;
  getPoolMetrics(): Promise<PoolMetrics>;
  getUnderwriter(address: string): Promise<UnderwriterPosition>;
  listPolicies(): Promise<Policy[]>;
  getIncidents(): Promise<Incident[]>;
  quotePremium(coverage: bigint, durationBlocks: number, minUptimeBps: number): Promise<bigint>;
  /** Wallet balance in atto-GEN, or null when it cannot be read. */
  getBalance(address: string): Promise<bigint | null>;

  deposit(sender: string, amount: bigint): Promise<TxReceipt>;
  withdraw(sender: string, amount: bigint): Promise<TxReceipt>;
  createPolicy(sender: string, args: CreatePolicyArgs, premium: bigint): Promise<TxReceipt>;
  triggerProbe(sender: string, policyId: number, bond: bigint): Promise<TxReceipt>;
  settleClaim(sender: string, policyId: number, bond: bigint): Promise<TxReceipt>;
  expirePolicy(sender: string, policyId: number): Promise<TxReceipt>;
}

/** Pull a readable revert reason (e.g. "[EXPOSURE_CAP] per-holder exposure cap reached") out of any thrown value. */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "Transaction failed";
  const m = /(\[[A-Z_]+\][^\n"]*)/.exec(raw);
  return (m ? m[1] : raw).trim().slice(0, 240);
}
