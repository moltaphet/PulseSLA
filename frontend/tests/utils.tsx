import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { DemoClient } from "@/lib/chain/demo";
import type { ProtocolClient } from "@/lib/chain/client";
import { ProtocolProvider } from "@/lib/hooks/useProtocol";
import type { Eip1193Provider } from "@/lib/hooks/useWallet";
import { createDemoWorld, DEMO_ACCOUNT } from "@/lib/sim/seed";

export const NOW = 1_900_000_000;
export { DEMO_ACCOUNT };

/** A zero-latency demo client over the deterministic seeded world. */
export function makeDemo(): DemoClient {
  return new DemoClient(createDemoWorld(NOW), 0);
}

/** The demo world with its staged claim dismissed, so nothing is reserved and deposits are open. */
export function makeDemoUnfrozen(): DemoClient {
  const c = makeDemo();
  c.sim.setEndpoint("relay.nimbus-bridge.net", "healthy");
  c.advance(7200); // past the claim grace period
  c.sim.settleClaim(DEMO_ACCOUNT, 3, c.sim.cfg.probeBond);
  c.sim.setEndpoint("rpc.helios-node.io", "healthy");
  if (c.sim.metrics().reservedPayouts !== 0n) throw new Error("demo world still has reserved claims");
  return c;
}

export function renderWithProtocol(
  ui: ReactElement,
  opts: { client?: ProtocolClient; walletProvider?: Eip1193Provider | null } = {},
): RenderResult & { client: ProtocolClient } {
  const client = opts.client ?? makeDemo();
  const result = render(
    <ProtocolProvider client={client} walletProvider={opts.walletProvider ?? null} pollMs={0}>
      {ui}
    </ProtocolProvider>,
  );
  return Object.assign(result, { client });
}

/** A scriptable EIP-1193 provider. */
export function fakeWallet(opts: { accounts?: string[]; chainId?: string; rejectConnect?: boolean } = {}) {
  let accounts = opts.accounts ?? [];
  let chainId = opts.chainId ?? "0xf22d";
  const listeners = new Map<string, Set<(...a: never[]) => void>>();
  const calls: string[] = [];
  const provider: Eip1193Provider = {
    async request({ method }) {
      calls.push(method);
      switch (method) {
        case "eth_accounts": return accounts;
        case "eth_chainId": return chainId;
        case "eth_requestAccounts":
          if (opts.rejectConnect) throw Object.assign(new Error("User rejected"), { code: 4001 });
          accounts = opts.accounts?.length ? opts.accounts : ["0xAbC0000000000000000000000000000000000001"];
          return accounts;
        case "wallet_switchEthereumChain": chainId = "0xf22d"; return null;
        default: return null;
      }
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener(event, handler) { listeners.get(event)?.delete(handler); },
  };
  return {
    provider,
    calls,
    emit(event: string, ...args: unknown[]) { listeners.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args)); },
    setChain(id: string) { chainId = id; },
  };
}
