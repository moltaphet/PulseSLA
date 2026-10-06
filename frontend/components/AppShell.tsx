"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { CHAIN_ID, CONTRACT_ADDRESS, explorerAddressUrl, NETWORK_LABEL } from "@/lib/config";
import { shortAddress } from "@/lib/units";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { ConnectButton } from "./ConnectButton";
import { DemoControls } from "./DemoControls";
import { TxBanner } from "./TxBanner";
import { Dot, Pill } from "./ui";

const NAV = [
  { href: "/", label: "Underwrite" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/sentinel", label: "Sentinel" },
  { href: "/incidents", label: "Incidents" },
  { href: "/about", label: "About" },
] as const;

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
        <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#8b5cf6" /><stop offset="1" stopColor="#10b981" /></linearGradient></defs>
        <rect width="32" height="32" rx="9" fill="url(#lg)" />
        <path d="M3 17h7l3-8 5 15 3-9 2 2h6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-lg font-bold tracking-tight text-white">Pulse<span className="bg-gradient-to-r from-emerald-400 to-cyan-300 bg-clip-text text-transparent">SLA</span></span>
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { mode, metrics, error } = useProtocol();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
          <Link href="/" aria-label="PulseSLA home"><Logo /></Link>
          <nav aria-label="Primary" className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ${active ? "bg-zinc-800 text-white shadow-[inset_0_-2px_0_#10b981]" : "text-zinc-300 hover:bg-zinc-800/60 hover:text-white"}`}>
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {mode === "demo" ? (
              <Pill tone="warn" title="No contract address is configured; the dashboard runs against an in-memory copy of the protocol.">
                <Dot tone="warn" /> Demo · simulated protocol
              </Pill>
            ) : (
              <Pill tone="pulse" title={`${NETWORK_LABEL} (chain ${CHAIN_ID})`}>
                <Dot tone="pulse" live /> Live · {NETWORK_LABEL}
              </Pill>
            )}
            <ConnectButton />
          </div>
        </div>
      </header>
      <TxBanner />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        {error && (
          <div role="alert" className="mb-6 rounded-lg border border-danger/40 bg-danger-dim px-4 py-3 text-sm text-danger">
            Could not read protocol state: {error}
          </div>
        )}
        {children}
      </main>
      <footer className="border-t border-zinc-800/80 bg-zinc-950/60 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-3 text-sm text-zinc-400">Parametric SLA insurance for Web3 infrastructure, detected and settled by GenLayer validator consensus.</p>
          </div>
          <dl className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm">
            <dt className="text-zinc-400">Network</dt><dd className="font-medium text-zinc-100">{NETWORK_LABEL}</dd>
            <dt className="text-zinc-400">Mode</dt><dd className="font-medium text-zinc-100">{mode === "demo" ? "Simulated" : "Live"}</dd>
            <dt className="text-zinc-400">Contract</dt>
            <dd className="font-medium text-zinc-100">
              {mode === "live" && CONTRACT_ADDRESS ? <a className="num text-emerald-300 underline decoration-dotted hover:text-emerald-200" href={explorerAddressUrl(CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">{shortAddress(CONTRACT_ADDRESS)}</a> : "not deployed"}
            </dd>
            <dt className="text-zinc-400">Probes recorded</dt><dd className="num font-medium text-zinc-100">{metrics ? metrics.totalProbes : "—"}</dd>
          </dl>
        </div>
      </footer>
      {mode === "demo" && <DemoControls />}
    </div>
  );
}
