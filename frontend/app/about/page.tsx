import type { ReactNode } from "react";

export const metadata = {
  title: "About · PulseSLA",
  description: "How PulseSLA turns infrastructure SLAs into autonomous, consensus-settled parametric insurance.",
};

export const TEST_COUNTS = { contract: 125, frontend: 359 } as const;
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;
const DOCS_URL = "https://docs.genlayer.com";

const STEPS = [
  { n: "01", title: "Underwriting pools", tone: "from-violet-500 to-indigo-500", body: "Liquidity providers deposit GEN into one shared pool. They earn the premium of every policy and absorb confirmed payouts pro rata through share-price accounting." },
  { n: "02", title: "Parametric policy creation", tone: "from-emerald-500 to-teal-400", body: "Node operators and protocols buy cover on an endpoint, choosing a latency ceiling in milliseconds, an uptime floor from 99.0% to 99.9%, coverage and duration. The premium is quoted on-chain, to the wei." },
  { n: "03", title: "Decentralized GenVM probing", tone: "from-cyan-400 to-sky-500", body: "Anyone can trigger a probe with a small bond. The leader and every validator independently request the endpoint, check the HTTP status is 200, measure latency, and assert that eth_blockNumber is advancing." },
  { n: "04", title: "Autonomous settlement", tone: "from-amber-400 to-rose-500", body: "When a verified breach survives the grace window and a second consensus round, the payout is released programmatically to the policyholder. No claim adjuster, no paperwork." },
] as const;

const SAFEGUARDS = [
  { title: "Pre-activation health verification", body: "Cover only exists after the endpoint has been observed healthy. Buying a policy on an already-dead node never pays, and an activation delay blocks instant claims." },
  { title: "3 consecutive failures + grace window", body: "A single glitch cannot trigger a claim. It takes three failing probes with uptime below the SLA floor, then a grace period, then a fresh consensus round that must still see the failure." },
  { title: "7-day linear payout vesting", body: "A new policy vests 25% of coverage, rising linearly to 100% over seven days. Insuring your own node and crashing it on purpose stops being profitable." },
  { title: "Pool solvency invariant", body: "Coverage is locked when a policy is minted, and locked coverage can never exceed pool assets. A payout lowers both together, so the pool can never be overdrawn. Per-policy, per-host, per-holder and 80% utilization caps bound concentration." },
] as const;

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-6 shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_8px_30px_rgb(0_0_0/0.25)] backdrop-blur-md transition-colors hover:border-zinc-700/60 ${className}`}>
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">{children}</p>;
}

export default function AboutPage() {
  return (
    <div className="space-y-16">
      <section aria-labelledby="overview" className="relative">
        <Eyebrow>Protocol specs</Eyebrow>
        <h1 id="overview" className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-white sm:text-5xl">
          Infrastructure SLAs that <span className="bg-gradient-to-r from-emerald-400 to-cyan-300 bg-clip-text text-transparent">pay themselves</span>
        </h1>
        <p className="mt-4 max-w-3xl text-lg text-zinc-300">
          PulseSLA is parametric downtime insurance for RPC nodes, indexers, bridge relays and sequencers, detected and settled entirely by GenLayer validator consensus.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-5">
          <Panel className="lg:col-span-3">
            <h2 className="text-lg font-semibold text-white">Why PulseSLA?</h2>
            <ul className="mt-3 space-y-3 text-zinc-300">
              <li className="flex gap-3"><span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-rose-400" />Traditional SLA penalties are resolved off-chain through slow legal arbitration and discretionary claim review. Operators wait weeks, and disputes are routine.</li>
              <li className="flex gap-3"><span aria-hidden className="mt-2 h-2 w-2 shrink-0 rounded-full bg-rose-400" />Existing EVM oracles cannot probe raw HTTP or RPC endpoints. They report on-chain prices, not whether an API answered in time.</li>
            </ul>
          </Panel>
          <Panel className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-zinc-900/70 lg:col-span-2">
            <h2 className="text-lg font-semibold text-white">The solution</h2>
            <p className="mt-3 text-zinc-200">
              Autonomous parametric payouts powered by GenVM&apos;s native web consensus. Validators query the endpoint themselves and agree on the verdict, so the SLA is the oracle and the payout is code.
            </p>
          </Panel>
        </div>
      </section>

      <section aria-labelledby="how">
        <Eyebrow>How it works</Eyebrow>
        <h2 id="how" className="mt-3 text-3xl font-bold tracking-tight text-white">From deposit to payout in four steps</h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-2">
          {STEPS.map((s) => (
            <li key={s.n}>
              <Panel className="h-full">
                <span className={`num inline-flex rounded-lg bg-gradient-to-br ${s.tone} px-2.5 py-1 text-sm font-bold text-zinc-950`}>{s.n}</span>
                <h3 className="mt-4 text-xl font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-zinc-300">{s.body}</p>
              </Panel>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="game-theory">
        <Eyebrow>Game theory</Eyebrow>
        <h2 id="game-theory" className="mt-3 text-3xl font-bold tracking-tight text-white">Four safeguards against self-dealing</h2>
        <p className="mt-2 max-w-3xl text-zinc-300">The attack to defeat: an operator insures its own node, takes it down, and collects. Each mechanism below removes part of that payoff.</p>
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {SAFEGUARDS.map((g, i) => (
            <li key={g.title}>
              <Panel className="h-full">
                <div className="flex items-center gap-3">
                  <span className="num flex h-8 w-8 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-500/10 text-sm font-bold text-emerald-300">{i + 1}</span>
                  <h3 className="text-lg font-semibold text-white">{g.title}</h3>
                </div>
                <p className="mt-3 text-zinc-300">{g.body}</p>
              </Panel>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-zinc-400">These bound the loss, they do not eliminate it: an operator using fresh addresses can still extract the vested fraction of capped coverage.</p>
      </section>

      <section aria-labelledby="metrics">
        <Eyebrow>Protocol metrics &amp; invariant proofs</Eyebrow>
        <h2 id="metrics" className="mt-3 text-3xl font-bold tracking-tight text-white">Verified, not asserted</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Panel><p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Contract tests</p><p data-testid="contract-tests" className="num mt-2 text-4xl font-bold text-emerald-300">{TEST_COUNTS.contract}</p><p className="mt-1 text-sm text-zinc-400">Pytest, in-memory GenVM, real validator logic</p></Panel>
          <Panel><p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Frontend tests</p><p data-testid="frontend-tests" className="num mt-2 text-4xl font-bold text-indigo-300">{TEST_COUNTS.frontend}</p><p className="mt-1 text-sm text-zinc-400">Vitest + React Testing Library</p></Panel>
          <Panel><p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Linter</p><p className="num mt-2 text-4xl font-bold text-white">0 errors</p><p className="mt-1 text-sm text-zinc-400">genvm-lint check and typecheck</p></Panel>
          <Panel><p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Solvency</p><p className="num mt-2 text-4xl font-bold text-white">locked ≤ assets</p><p className="mt-1 text-sm text-zinc-400">Asserted after every settlement, including 8 simultaneous breaches</p></Panel>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          {REPO_URL && <a href={REPO_URL} target="_blank" rel="noreferrer" className="rounded-xl border border-zinc-700 bg-zinc-800/70 px-5 py-2.5 text-sm font-semibold text-zinc-100 hover:border-zinc-500">GitHub repository ↗</a>}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/20 hover:brightness-110">GenLayer docs ↗</a>
        </div>
      </section>
    </div>
  );
}
