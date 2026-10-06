/** GenLayer networks the dashboard can talk to. Chain 61997 is Studio Next. */
export interface NetworkConfig {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
}

export const STUDIO_NEXT: NetworkConfig = {
  key: "studio-next",
  label: "GenLayer Studio Next",
  chainId: 61997,
  rpcUrl: process.env.NEXT_PUBLIC_PULSESLA_RPC_URL ?? "https://studio-next.genlayer.com/api",
  explorerUrl: "https://explorer-studio-next.genlayer.com",
};

export const DEFAULT_NETWORK = STUDIO_NEXT;
