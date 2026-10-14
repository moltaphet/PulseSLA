"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { createProtocolClient } from "../chain";
import { errorMessage, type ProtocolClient } from "../chain/client";
import { DemoClient, isDemoClient } from "../chain/demo";
import { CHAIN_ID, resolveMode } from "../config";
import type {
  CreatePolicyArgs, Endpoint, Incident, Policy, PoolMetrics, TxReceipt, UnderwriterPosition,
} from "../types";
import { useWallet, type Eip1193Provider, type WalletState } from "./useWallet";

export type TxStatus =
  | { phase: "idle" }
  | { phase: "pending"; summary: string }
  | { phase: "success"; summary: string; receipt: TxReceipt }
  | { phase: "error"; summary: string; message: string };

/** Where the connected account's own data stands. It is never inferred from another account's data. */
export type PersonalStatus = "none" | "loading" | "ready" | "error";

/** Account-specific reads, tagged with the account they were read for. */
interface Personal {
  account: string;
  position: UnderwriterPosition | null;
  balance: bigint | null;
  error: string | null;
}

export interface ProtocolContextValue {
  mode: ProtocolClient["mode"];
  client: ProtocolClient;
  wallet: WalletState;
  /** Acting account: the demo account in demo mode, the connected wallet in live mode. */
  account: string | null;
  canTransact: boolean;
  /** Why `canTransact` is false (null when it is true). */
  blockedReason: string | null;
  /** State of the acting account's position and balance: actions that depend on them wait for "ready". */
  personalStatus: PersonalStatus;
  metrics: PoolMetrics | null;
  position: UnderwriterPosition | null;
  balance: bigint | null;
  endpoints: Endpoint[];
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
  releasePayout(policyId: number): Promise<TxReceipt | null>;
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
  /** Test seam: inject a client (e.g. a zero-delay DemoClient). */
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

  const [metrics, setMetrics] = useState<PoolMetrics | null>(null);
  // Position and balance belong to ONE account. They are stored with their owner and only ever exposed for the
  // account that is acting now, so switching accounts purges them at once (no effect, no stale frame).
  const [personal, setPersonal] = useState<Personal | null>(null);
  const mine = personal !== null && personal.account === account ? personal : null;
  const position = mine?.position ?? null;
  const balance = mine?.balance ?? null;
  const personalStatus: PersonalStatus = account === null ? "none" : mine === null ? "loading" : mine.error ? "error" : "ready";
  const walletReady = client.mode === "demo" ? true : wallet.status === "connected" && !wallet.wrongNetwork;
  const canTransact = walletReady && (client.mode === "demo" || personalStatus === "ready");
  const blockedReason = canTransact ? null
    : !walletReady ? (wallet.wrongNetwork ? "Switch to the GenLayer network" : "Connect a wallet")
    : personalStatus === "error" ? "Could not read your account: actions are disabled until it loads"
    : "Loading your account…";
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A transaction banner belongs to the account that sent it.
  const [txState, setTxState] = useState<{ tx: TxStatus; account: string | null }>({ tx: { phase: "idle" }, account: null });
  const tx: TxStatus = txState.account === account ? txState.tx : { phase: "idle" };
  const [votes, setVotes] = useState<Record<number, NonNullable<Incident["votes"]>>>({});
  const seq = useRef(0);
  const accountRef = useRef<string | null>(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  const load = useCallback(async (): Promise<Incident[] | null> => {
    const mineSeq = ++seq.current;
    const forAccount = account;
    // Superseded by a newer refresh, or read for an account that is no longer the acting one.
    const stale = () => mineSeq !== seq.current || accountRef.current !== forAccount;
    const readGlobal = Promise.all([client.getPoolMetrics(), client.listPolicies(), client.getIncidents(), client.listEndpoints()]);
    const readPersonal = forAccount
      ? Promise.all([client.getUnderwriter(forAccount), client.getBalance(forAccount)])
      : Promise.resolve(null);
    const [g, pr] = await Promise.allSettled([readGlobal, readPersonal]);
    if (stale()) return null;
    let latest: Incident[] | null = null;
    let failure: string | null = null;
    if (g.status === "fulfilled") {
      const [m, ps, inc, eps] = g.value;
      setMetrics(m);
      setPolicies(ps);
      setEndpoints(eps);
      setIncidents(inc);
      setNow(isDemoClient(client) ? client.now : Math.floor(Date.now() / 1000));
      latest = inc;
    } else failure = errorMessage(g.reason);
    if (forAccount === null) setPersonal(null);
    else if (pr.status === "fulfilled" && pr.value !== null) {
      setPersonal({ account: forAccount, position: pr.value[0], balance: pr.value[1], error: null });
    } else if (pr.status === "rejected") {
      // The read for THIS account failed: its position is unknown (never the previous account's, never the last value).
      const message = errorMessage(pr.reason);
      setPersonal({ account: forAccount, position: null, balance: null, error: message });
      failure ??= message;
    }
    setError(failure);
    setLoading(false);
    return latest;
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
      const sender = account;
      const setTx = (next: TxStatus) => setTxState({ tx: next, account: sender });
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
    [load, account],
  );

  const need = (): string => {
    if (!account) throw new Error("Connect a wallet first");
    return account;
  };
  const probeBond = metrics?.probeBond ?? 0n;

  const value = useMemo<ProtocolContextValue>(
    () => ({
      mode: client.mode, client, wallet, account, canTransact, metrics, position, balance, endpoints, policies, incidents, now,
      loading, error, tx, refresh, votesByIncident: votes, blockedReason, personalStatus,
      dismissTx: () => setTxState({ tx: { phase: "idle" }, account }),
      quote: (c, b, u) => client.quotePremium(c, b, u),
      deposit: async (amount) => (await exec("Deposit underwriting capital", () => client.deposit(need(), amount), () => true)) ?? false,
      withdraw: async (amount) => (await exec("Withdraw underwriting capital", () => client.withdraw(need(), amount), () => true)) ?? false,
      createPolicy: async (args, premium) => {
        const r = await exec("Mint SLA policy", () => client.createPolicy(need(), args, premium), (x) => x);
        if (!r) return null;
        // The new policy is this account's newest one on that endpoint, never "the newest in the pool": another
        // holder may have minted between the transaction and this read.
        const list = await client.listPolicies();
        const mineNow = list.filter((p) => p.holder.toLowerCase() === need().toLowerCase() && p.endpointId === args.endpointId);
        return mineNow.length > 0 ? Math.max(...mineNow.map((p) => p.id)) : null;
      },
      triggerProbe: (id) => exec(`Probe policy #${id}`, () => client.triggerProbe(need(), id, probeBond), (r) => r, id),
      settleClaim: (id) => exec(`Settle claim on policy #${id}`, () => client.settleClaim(need(), id, probeBond), (r) => r, id),
      releasePayout: (id) => exec(`Release payout on policy #${id}`, () => client.releasePayout(need(), id), (r) => r),
      expirePolicy: async (id) => (await exec(`Expire policy #${id}`, () => client.expirePolicy(need(), id), () => true)) ?? false,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, wallet, account, canTransact, blockedReason, personalStatus, metrics, position, balance, endpoints, policies, incidents, now, loading, error, tx, refresh, votes, exec, probeBond],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
