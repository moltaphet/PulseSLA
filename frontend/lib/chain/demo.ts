import { createDemoWorld, DEMO_ACCOUNT } from "../sim/seed";
import type { EndpointMode, SimProtocol } from "../sim/engine";
import type { ProtocolClient } from "./client";
import type { CreatePolicyArgs, TxReceipt } from "../types";

let counter = 0;
const hash = () => `0xdemo${(++counter).toString(16).padStart(8, "0")}${"0".repeat(52)}`;
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** In-memory protocol. Writes behave like transactions (they can revert with the contract's own error codes). */
export class DemoClient implements ProtocolClient {
  readonly mode = "demo" as const;
  readonly account = DEMO_ACCOUNT;

  constructor(
    readonly sim: SimProtocol = createDemoWorld(),
    private readonly latencyMs = 450,
  ) {}

  async getPoolMetrics() { return this.sim.metrics(); }
  async getUnderwriter(address: string) { return this.sim.underwriter(address.toLowerCase()); }
  async listPolicies() { return this.sim.policies.map((p) => ({ ...p })); }
  async getIncidents() { return this.sim.incidents.map((i) => ({ ...i })); }
  async quotePremium(coverage: bigint, durationBlocks: number, uptime: number) { return this.sim.quote(coverage, durationBlocks, uptime); }
  async getBalance(address: string) { return this.sim.balanceOf(address.toLowerCase()); }

  private async tx<T>(summary: string, run: () => T, receipt: (r: T) => Partial<TxReceipt> = () => ({})): Promise<TxReceipt> {
    await sleep(this.latencyMs);
    const out = run(); // reverts surface as ProtocolError, like a failed transaction
    return { hash: hash(), summary, ...receipt(out) };
  }

  deposit(sender: string, amount: bigint) { return this.tx("Deposit underwriting capital", () => this.sim.deposit(sender, amount)); }
  withdraw(sender: string, amount: bigint) { return this.tx("Withdraw underwriting capital", () => this.sim.withdraw(sender, amount)); }
  createPolicy(sender: string, args: CreatePolicyArgs, premium: bigint) {
    return this.tx("Mint SLA policy", () => this.sim.createPolicy(sender, args, premium));
  }
  triggerProbe(sender: string, policyId: number, bond: bigint) {
    return this.tx(`Probe policy #${policyId}`, () => this.sim.triggerProbe(sender, policyId, bond), (r) => ({
      votes: r.votes,
      outcome: { ok: r.ok, reason: r.reason, breachStaged: r.breachStaged },
    }));
  }
  settleClaim(sender: string, policyId: number, bond: bigint) {
    return this.tx(`Settle claim on policy #${policyId}`, () => this.sim.settleClaim(sender, policyId, bond), (r) => ({
      votes: r.votes,
      outcome: { paid: r.paid, payout: r.payout, reason: r.reason },
    }));
  }
  expirePolicy(_sender: string, policyId: number) { return this.tx(`Expire policy #${policyId}`, () => this.sim.expirePolicy(policyId)); }

  // ---- demo-only controls -------------------------------------------------
  endpointModes(): { host: string; mode: EndpointMode; block: number }[] {
    for (const p of this.sim.policies) this.sim.ensureEndpoint(p.host);
    return [...this.sim.endpoints.entries()].map(([host, ep]) => ({ host, mode: ep.mode, block: ep.block }));
  }
  setEndpoint(host: string, mode: EndpointMode) { this.sim.setEndpoint(host, mode); }
  advance(seconds: number) { this.sim.advance(seconds); }
  get now() { return this.sim.now; }
}

export function isDemoClient(c: ProtocolClient): c is DemoClient {
  return c.mode === "demo";
}
