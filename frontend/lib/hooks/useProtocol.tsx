"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { createProtocolClient } from "../chain";
import { errorMessage, type ProtocolClient } from "../chain/client";
import { DemoClient, isDemoClient } from "../chain/demo";
import { CHAIN_ID, resolveMode } from "../config";
import type {
  CreatePolicyArgs, Incident, Policy, PoolMetrics, TxReceipt, UnderwriterPosition,
} from "../types";
import { useWallet, type Eip1193Provider, type WalletState } from "./useWallet";

export type TxStatus =
  | { phase: "idle" }
  | { phase: "pending"; summary: string }
  | { phase: "success"; summary: string; receipt: TxReceipt }
  | { phase: "error"; summary: string; message: string };

export interface ProtocolContextValue {
  mode: ProtocolClient["mode"];
  client: ProtocolClient;
  wallet: WalletState;
  /** Acting account: the demo account in demo mode, the connected wallet in live mode. */
  account: string | null;
  canTransact: boolean;
  metrics: PoolMetrics | null;
  position: UnderwriterPosition | null;
  balance: bigint | null;
  policies: Policy[];
  incidents: Incident[];
  /** Unix seconds: the simulated clock in demo mode, wall time in live mode. */
  now: number;
  loading: boolean;
  error: string | null;
  tx: TxStatus;
  refresh(): Promise<void>;
  dismissTx(): void;
  deposit(amount: bigint): Promise<boolean>;
  withdraw(amount: bigint): Promise<boolean>;
  createPolicy(args: CreatePolicyArgs, premium: bigint): Promise<number | null>;
  triggerProbe(policyId: number): Promise<TxReceipt | null>;
  settleClaim(policyId: number): Promise<TxReceipt | null>;
  expirePolicy(policyId: number): Promise<boolean>;
  quote(coverage: bigint, durationBlocks: number, minUptimeBps: number): Promise<bigint>;
  /** Votes observed this session, keyed by incident index, so the inspector can show the roll call. */
  votesByIncident: Record<number, NonNullable<Incident["votes"]>>;
}

const Ctx = createContext<ProtocolContextValue | null>(null);

export function useProtocol(): ProtocolContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProtocol must be used inside <ProtocolProvider>");
  return v;
}

interface ProviderProps {
  children: ReactNode;
  /** Test seam: inject a client (e.g. a zero-latency DemoClient). */
  client?: ProtocolClient;
  /** Test seam: inject an EIP-1193 provider, or null for "no wallet". */
  walletProvider?: Eip1193Provider | null;
  pollMs?: number;
}

export function ProtocolProvider({ children, client: injected, walletProvider, pollMs = 15_000 }: ProviderProps) {
  const wallet = useWallet(walletProvider, CHAIN_ID);
  const [demoClient] = useState<ProtocolClient | null>(() => (injected ? null : resolveMode() === "demo" ? new DemoClient() : null));
  const client = useMemo<ProtocolClient>(
    () => injected ?? demoClient ?? createProtocolClient({ provider: wallet.provider }),
    [injected, demoClient, wallet.provider],
  );

  const account = client.mode === "demo" ? (isDemoClient(client) ? client.account : null) : wallet.account;
  const canTransact = client.mode === "demo" ? true : wallet.status === "connected" && !wallet.wrongNetwork;

  const [metrics, setMetrics] = useState<PoolMetrics | null>(null);
  const [position, setPosition] = useState<UnderwriterPosition | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<TxStatus>({ phase: "idle" });
  const [votes, setVotes] = useState<Record<number, NonNullable<Incident["votes"]>>>({});
  const seq = useRef(0);

  const load = useCallback(async (): Promise<Incident[] | null> => {
    const mine = ++seq.current;
    try {
      const [m, ps, inc] = await Promise.all([client.getPoolMetrics(), client.listPolicies(), client.getIncidents()]);
      const [pos, bal] = account
        ? await Promise.all([client.getUnderwriter(account), client.getBalance(account)])
        : [null, null];
      if (mine !== seq.current) return null; // a newer refresh superseded this one
      setMetrics(m);
      setPolicies(ps);
      setIncidents(inc);
      setPosition(pos);
      setBalance(bal);
      setNow(isDemoClient(client) ? client.now : Math.floor(Date.now() / 1000));
      setError(null);
      return inc;
    } catch (e) {
      if (mine === seq.current) setError(errorMessage(e));
      return null;
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [client, account]);
  const refresh = useCallback(async () => { await load(); }, [load]);

  // Deferred one tick so the initial fetch is not a synchronous state update inside the effect body.
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (client.mode !== "live" || pollMs <= 0) return;
    const id = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(id);
  }, [client.mode, pollMs, refresh]);

  const exec = useCallback(
    async <T,>(summary: string, run: () => Promise<TxReceipt>, pick: (r: TxReceipt) => T, policyId?: number): Promise<T | null> => {
      setTx({ phase: "pending", summary });
      try {
        const receipt = await run();
        setTx({ phase: "success", summary, receipt });
        const latest = await load();
        // Attach this session's vote roll to the incident it produced (the chain keeps only the leader's view).
        if (receipt.votes && latest && policyId !== undefined) {
          const obs = latest.filter((i) => i.policyId === policyId && i.ok !== undefined).at(-1);
          if (obs) setVotes((v) => ({ ...v, [obs.index]: receipt.votes! }));
        }
        return pick(receipt);
      } catch (e) {
        setTx({ phase: "error", summary, message: errorMessage(e) });
        return null;
      }
    },
    [load],
  );

  const need = (): string => {
    if (!account) throw new Error("Connect a wallet first");
    return account;
  };
  const probeBond = metrics?.probeBond ?? 0n;

  const value = useMemo<ProtocolContextValue>(
    () => ({
      mode: client.mode, client, wallet, account, canTransact, metrics, position, balance, policies, incidents, now,
      loading, error, tx, refresh, votesByIncident: votes,
      dismissTx: () => setTx({ phase: "idle" }),
      quote: (c, b, u) => client.quotePremium(c, b, u),
      deposit: async (amount) => (await exec("Deposit underwriting capital", () => client.deposit(need(), amount), () => true)) ?? false,
      withdraw: async (amount) => (await exec("Withdraw underwriting capital", () => client.withdraw(need(), amount), () => true)) ?? false,
      createPolicy: async (args, premium) => {
        const r = await exec("Mint SLA policy", () => client.createPolicy(need(), args, premium), (x) => x);
        if (!r) return null;
        const list = await client.listPolicies();
        return list.length > 0 ? list[list.length - 1].id : null;
      },
      triggerProbe: (id) => exec(`Probe policy #${id}`, () => client.triggerProbe(need(), id, probeBond), (r) => r, id),
      settleClaim: (id) => exec(`Settle claim on policy #${id}`, () => client.settleClaim(need(), id, probeBond), (r) => r, id),
      expirePolicy: async (id) => (await exec(`Expire policy #${id}`, () => client.expirePolicy(need(), id), () => true)) ?? false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, wallet, account, canTransact, metrics, position, balance, policies, incidents, now, loading, error, tx, refresh, votes, exec, probeBond],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
