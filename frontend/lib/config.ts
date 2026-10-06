import { CONTRACT_ADDRESS as DEPLOYED_ADDRESS } from "./contracts";
import { DEFAULT_NETWORK } from "./networks";

export const CHAIN_ID = DEFAULT_NETWORK.chainId; // GenLayer Studio Next
export const NETWORK_LABEL = DEFAULT_NETWORK.label;
export const RPC_URL = DEFAULT_NETWORK.rpcUrl;
export const EXPLORER_URL = DEFAULT_NETWORK.explorerUrl;

/** Address written by scripts/deploy.py, or overridden per environment. */
export const CONTRACT_ADDRESS: string | null = DEPLOYED_ADDRESS;

export type AppMode = "live" | "demo";

/** Live when a contract address is configured, unless demo is forced. */
export function resolveMode(address: string | null = CONTRACT_ADDRESS, forced: string | undefined = process.env.NEXT_PUBLIC_PULSESLA_MODE): AppMode {
  if (forced === "demo") return "demo";
  return address ? "live" : "demo";
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
