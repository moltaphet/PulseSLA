import { CONTRACT_ADDRESS } from "../config";
import { LiveClient } from "./live";
import type { ProtocolClient } from "./client";

export * from "./client";

/** Live client for the configured contract. Throws if no address is configured (callers pick demo mode first). */
export function createProtocolClient(opts: {
  provider?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } | null;
  address?: string | null;
} = {}): ProtocolClient {
  const address = opts.address ?? CONTRACT_ADDRESS;
  if (!address) throw new Error("PulseSLA contract address is not configured (run scripts/deploy.py or set NEXT_PUBLIC_PULSESLA_ADDRESS)");
  return new LiveClient(address, opts.provider ?? null);
}
