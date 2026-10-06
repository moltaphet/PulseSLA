"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CHAIN_ID, NETWORK_LABEL, RPC_URL } from "../config";

/** The slice of EIP-1193 the app needs from an injected wallet. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected";

export interface WalletState {
  status: WalletStatus;
  account: string | null;
  chainId: number | null;
  wrongNetwork: boolean;
  error: string | null;
  provider: Eip1193Provider | null;
  connect(): Promise<void>;
  disconnect(): void;
  switchNetwork(): Promise<void>;
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

const subscribeNever = () => () => {};
const getNoProvider = (): Eip1193Provider | null => null;

function parseChainId(v: unknown): number | null {
  if (typeof v === "string") {
    const n = v.startsWith("0x") ? parseInt(v, 16) : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return typeof v === "number" ? v : null;
}

function walletError(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return "Connection request was rejected in the wallet.";
  return err?.message ?? "Wallet error";
}

/**
 * Injected-wallet connection. Restores an already-authorised session without
 * prompting (`eth_accounts`), tracks account / network changes, and reports a
 * wrong network instead of silently signing on it.
 */
export function useWallet(providerOverride?: Eip1193Provider | null, expectedChainId: number = CHAIN_ID): WalletState {
  // useSyncExternalStore keeps the server render ("no wallet") and the first client render identical, then switches to the real provider.
  const injected = useSyncExternalStore(subscribeNever, getInjectedProvider, getNoProvider);
  const provider = providerOverride !== undefined ? providerOverride : injected;
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore a previously authorised session without opening the wallet.
  useEffect(() => {
    if (!provider) return;
    let live = true;
    void (async () => {
      try {
        const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
        const chain = await provider.request({ method: "eth_chainId" });
        if (!live) return;
        setAccount(accounts?.[0]?.toLowerCase() ?? null);
        setChainId(parseChainId(chain));
      } catch {
        /* a locked wallet simply stays disconnected */
      }
    })();
    return () => {
      live = false;
    };
  }, [provider]);

  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (accounts: string[]) => setAccount(accounts?.[0]?.toLowerCase() ?? null);
    const onChain = (id: string) => setChainId(parseChainId(id));
    provider.on("accountsChanged", onAccounts as never);
    provider.on("chainChanged", onChain as never);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts as never);
      provider.removeListener?.("chainChanged", onChain as never);
    };
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) {
      setError("No injected wallet found. Install a browser wallet to connect.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accounts?.[0]?.toLowerCase() ?? null);
      setChainId(parseChainId(await provider.request({ method: "eth_chainId" })));
    } catch (e) {
      setError(walletError(e));
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const disconnect = useCallback(() => {
    // Injected wallets cannot be disconnected programmatically; forget the session locally.
    setAccount(null);
    setError(null);
  }, []);

  const switchNetwork = useCallback(async () => {
    if (!provider) return;
    const hexId = `0x${expectedChainId.toString(16)}`;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if ((e as { code?: number })?.code === 4902) {
        try {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: hexId, chainName: NETWORK_LABEL, rpcUrls: [RPC_URL],
              nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
            }],
          });
        } catch (e2) {
          setError(walletError(e2));
        }
      } else setError(walletError(e));
    }
  }, [provider, expectedChainId]);

  const status: WalletStatus = !provider ? "unavailable" : connecting ? "connecting" : account ? "connected" : "disconnected";
  return useMemo(
    () => ({
      status, account, chainId, wrongNetwork: account !== null && chainId !== null && chainId !== expectedChainId,
      error, provider, connect, disconnect, switchNetwork,
    }),
    [status, account, chainId, expectedChainId, error, provider, connect, disconnect, switchNetwork],
  );
}
