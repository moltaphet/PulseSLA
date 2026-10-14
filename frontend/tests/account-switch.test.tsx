import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProtocolClient } from "@/lib/chain/client";
import { ProtocolProvider, useProtocol, type ProtocolContextValue } from "@/lib/hooks/useProtocol";
import type { Endpoint, Policy, PoolMetrics, TxReceipt, UnderwriterPosition } from "@/lib/types";
import { ATTO } from "@/lib/units";
import { fakeWallet } from "./utils";

const A = "0xaaa0000000000000000000000000000000000001";
const B = "0xbbb0000000000000000000000000000000000002";

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const METRICS = { probeBond: 10n ** 16n, stagedClaims: 0n, tvl: 100n * ATTO } as unknown as PoolMetrics;
const pos = (shares: bigint, value: bigint): UnderwriterPosition => ({ shares, value, withdrawable: value });
const receipt = (): TxReceipt => ({ hash: "0xh", summary: "ok" });

/** A live-mode client whose per-account reads are scripted. */
function scripted(reads: Record<string, () => Promise<UnderwriterPosition>>, policies: () => Policy[] = () => []): ProtocolClient {
  return {
    mode: "live",
    getPoolMetrics: async () => METRICS,
    getUnderwriter: (addr) => reads[addr.toLowerCase()](),
    listEndpoints: async () => [] as Endpoint[],
    listPolicies: async () => policies(),
    getIncidents: async () => [],
    quotePremium: async () => 1n,
    getBalance: async () => 7n * ATTO,
    deposit: async () => receipt(),
    withdraw: async () => receipt(),
    createPolicy: async () => receipt(),
    triggerProbe: async () => receipt(),
    settleClaim: async () => receipt(),
    releasePayout: async () => receipt(),
    expirePolicy: async () => receipt(),
  };
}

function mount(client: ProtocolClient, accounts: string[]) {
  const wallet = fakeWallet({ accounts });
  let ctx!: ProtocolContextValue;
  function Probe() {
    ctx = useProtocol();
    return null;
  }
  render(
    <ProtocolProvider client={client} walletProvider={wallet.provider} pollMs={0}>
      <Probe />
    </ProtocolProvider>,
  );
  return { wallet, get: () => ctx };
}

describe("account switching (audit finding 6)", () => {
  it("purges account A's position the instant the wallet switches, and a failed read for B never shows A's data", async () => {
    let failB = false;
    const client = scripted({
      [A]: async () => pos(123n, 456n),
      [B]: async () => { if (failB) throw new Error("rpc down"); return pos(1n, 2n); },
    });
    failB = true;
    const { wallet, get } = mount(client, [A]);
    await waitFor(() => expect(get().position).toEqual(pos(123n, 456n)));
    expect(get().canTransact).toBe(true);

    act(() => wallet.emit("accountsChanged", [B]));
    // Purged synchronously with the switch: there is no frame that shows A's numbers under B.
    expect(get().account).toBe(B);
    expect(get().position).toBeNull();
    expect(get().balance).toBeNull();
    expect(get().canTransact).toBe(false);

    await waitFor(() => expect(get().personalStatus).toBe("error"));
    expect(get().position).toBeNull(); // the audit's PoC kept shares=123 / value=456 here
    expect(get().balance).toBeNull();
    expect(get().canTransact).toBe(false);
    expect(get().blockedReason).toMatch(/Could not read your account/);
    expect(get().error).toMatch(/rpc down/);
  });

  it("ignores a late response that was read for the previous account", async () => {
    const slowA = deferred<UnderwriterPosition>();
    const client = scripted({ [A]: () => slowA.promise, [B]: async () => pos(9n, 90n) });
    const { wallet, get } = mount(client, [A]);
    await waitFor(() => expect(get().account).toBe(A));
    expect(get().personalStatus).toBe("loading");
    act(() => wallet.emit("accountsChanged", [B]));
    await waitFor(() => expect(get().position).toEqual(pos(9n, 90n)));
    await act(async () => { slowA.resolve(pos(123n, 456n)); await slowA.promise; });
    expect(get().account).toBe(B);
    expect(get().position).toEqual(pos(9n, 90n));
    expect(get().canTransact).toBe(true);
  });

  it("does not let account A's transaction banner follow the wallet to account B", async () => {
    const client = scripted({ [A]: async () => pos(1n, 1n), [B]: async () => pos(2n, 2n) });
    const { wallet, get } = mount(client, [A]);
    await waitFor(() => expect(get().canTransact).toBe(true));
    await act(async () => { await get().deposit(ATTO); });
    expect(get().tx.phase).toBe("success");
    act(() => wallet.emit("accountsChanged", [B]));
    expect(get().tx.phase).toBe("idle");
  });

  it("selects the new policy id from this account's own policies, not the newest in the pool", async () => {
    const mk = (id: number, holder: string): Policy => ({ id, holder, endpointId: "alpha" } as Policy);
    // After the transaction, someone else minted policy 8 before this account's read.
    const client = scripted({ [A]: async () => pos(1n, 1n) }, () => [mk(5, B), mk(7, A), mk(8, B)]);
    const { get } = mount(client, [A]);
    await waitFor(() => expect(get().canTransact).toBe(true));
    let id: number | null = null;
    await act(async () => {
      id = await get().createPolicy({ endpointId: "alpha", coverage: ATTO, durationBlocks: 1000, minUptimeBps: 9990, probeIntervalBlocks: 25 }, 1n);
    });
    expect(id).toBe(7);
  });
});
