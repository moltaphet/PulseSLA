# PulseSLA

### Infrastructure SLAs that pay themselves.

PulseSLA is parametric downtime insurance for Web3 infrastructure: RPC nodes, indexers, bridge relays and sequencers. Validators probe the insured endpoint directly, reach consensus on whether it breached its SLA, and the contract releases the payout. There are no claim forms, no adjusters and no off-chain arbitration.

| | |
|---|---|
| **Network** | GenLayer Studio Next, chain ID `61997` |
| **Contract** | [`0xCac874c4A68d5Fa275FB1100B65A28F610F1ab5f`](https://explorer-studio-next.genlayer.com/address/0xCac874c4A68d5Fa275FB1100B65A28F610F1ab5f) |
| **RPC** | `https://studio-next.genlayer.com/api` |
| **Source** | [`contracts/uptime_sla.py`](contracts/uptime_sla.py), GenVM runner `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| **Records** | [`deployments/studio-next.json`](deployments/studio-next.json) (address, ABI, deploy receipt) · [`deployments/studio-next-verification.json`](deployments/studio-next-verification.json) (live transactions) |

> **Hardened build.** This deployment includes the rogue-leader block bound, net-asset redemptions, registrable-domain caps and the claim velocity ceiling. The previous deployment (`0x1848eeDa503717E58c0D7c411703593d8E54f8C3`) is archived in [`deployments/archive/`](deployments/archive/).
>
> **Testnet instance.** This deployment uses a 60 s activation delay and a 300 s claim grace so a complete probe can be demonstrated in minutes. The contract defaults are 3600 s each. Both values are immutable after deployment.
>
> **Latency is not enforced on-chain today.** See [§6](#6-clock-and-latency-transparency). Status codes, JSON-RPC payloads and block freshness are.

---

## Contents

1. [Problem and solution](#1-problem-and-solution)
2. [Architecture and core flow](#2-architecture-and-core-flow)
3. [Game theory and anti-collusion design](#3-game-theory-and-anti-collusion-design)
4. [Specification](#4-specification)
5. [Verification: what is proven, and what is not](#5-verification-what-is-proven-and-what-is-not)
6. [Clock and latency transparency](#6-clock-and-latency-transparency)
7. [Quickstart](#7-quickstart)

---

## 1. Problem and solution

**The problem.** Infrastructure providers sell uptime and latency promises. When they break them, remedies depend on trust: the provider's own status page, a support ticket, sometimes legal arbitration. Dispute resolution is slow, discretionary and off-chain. On-chain, the gap is structural. EVM oracles deliver prices and chain events. They cannot answer the question an SLA actually asks: *did this URL respond with HTTP 200, with a valid payload, and with a block height that is still advancing?*

**The GenLayer solution.** GenVM provides native, consensus-backed web access. A PulseSLA probe is a non-deterministic block: the leader requests the endpoint, every validator independently requests it again, and the transaction is accepted only if the validators agree on the verdict. The SLA becomes its own oracle, and settlement becomes a function call.

## 2. Architecture and core flow

Four roles interact with one contract:

| Role | Action | Contract method |
|---|---|---|
| **Underwriter** | Supplies GEN, earns premiums, absorbs confirmed payouts pro rata | `deposit_underwriting()` · `withdraw_underwriting(amount)` |
| **Policyholder** | Buys cover on an endpoint with chosen thresholds | `create_policy(…)` |
| **Challenger** (anyone) | Triggers a probe or settles a staged claim by posting a bond | `trigger_probe(id)` · `settle_claim(id)` |
| **Validators** | Probe the endpoint independently and agree on the verdict | (GenVM consensus) |

```
Underwriters ── GEN ──▶ ┌───────────────────────── pool ─────────────────────────┐
                        │ shares · locked coverage · reserved payouts            │
Policyholders ─premium─▶│                                                        │
                        │  create_policy ─▶ trigger_probe ─▶ breach staged       │
Challengers ──bond────▶ │                    (web consensus)      │ grace        │
                        │                                          ▼              │
                        │                 settle_claim ─ re-probe ─▶ payout       │
                        └────────────────────────────────────────────────────────┘
```

1. **Underwrite.** Deposits mint pool shares at the current share price. Premiums accrue to the pool, so the price rises as policies are written. Withdrawals are limited to capital not locked behind live coverage.
2. **Insure.** `create_policy(endpoint_url, max_latency_ms, coverage_amount, duration_blocks, min_uptime_bps, probe_interval_blocks, probe_mode)`. Two tiers are priced: **Gold** (uptime floor ≥ 99.9%, 8.0%/yr) and **Silver** (≥ 99.0%, 4.0%/yr); lower floors down to 90% are accepted at 2.0%/yr. `probe_mode` is `rpc` (POST `eth_blockNumber`) or `http` (GET). `quote_premium` returns the exact on-chain price. Overpayment is refunded.
3. **Probe.** Each validator checks the HTTP status is exactly 200, the JSON-RPC result parses as a block number, and the block height has advanced since the last probe. Validators must agree on the **verdict** (healthy or failing). The failure class (502 vs timeout vs frozen block) need not match.
4. **Stage.** Three consecutive failing probes, a prior healthy observation, and measured uptime below the policy's floor stage a claim. The payout is **reserved**, not paid.
5. **Settle.** After the grace period, `settle_claim` runs a second consensus round. If the endpoint is still failing, the vested payout is sent to the policy holder, regardless of who called. If it has recovered, the claim is dismissed and cover resumes.

**Bonds.** A probe or settlement bond is refunded when the round confirms a failure and forfeited to underwriters when the endpoint is healthy. Pointless probes therefore cost money, and useful ones are free.

**Observability.** `get_incidents` returns an append-only log of every policy, probe, breach, dismissal and payout, with the observed status, latency and block. `get_pool_metrics`, `get_policy_status`, `get_underwriter` and `list_policies` expose live state.

## 3. Game theory, economic assumptions and known limitations

**The attack:** an operator insures its own node, takes it down on purpose, and collects.

| Safeguard | Mechanism | Effect on the attack |
|---|---|---|
| **Pre-activation baseline** | Cover cannot be probed during the activation delay, and a claim can stage only after the endpoint has been observed healthy at least once. | Insuring an already-dead node never pays. Instant claims are impossible. |
| **3 consecutive failures + grace** | Failures must be consecutive, uptime must fall below the floor, a grace period must pass, and a *fresh* consensus round must still see the failure. | A transient glitch or a short, self-inflicted blip does not pay. A recovered node cancels the claim. |
| **7-day linear vesting** | Payout vests from 25% of coverage at policy start to 100% after 7 days. | A freshly bought policy pays at most about a quarter of coverage. |
| **Solvency invariant** | Coverage is locked at mint time. `locked_coverage ≤ pool_assets` holds after every operation. A payout reduces both sides equally. | The pool cannot be overdrawn, even if every policy breaches at once. |
| **Rogue-leader bound** | A validator rejects a leader whose block height differs from the validator's own observation by more than **10 blocks**, or is negative, zero on a healthy result, non-integer or above 2⁵³. | An isolated Byzantine leader cannot poison the stored `last_block` to induce, or hide, stale-block verdicts beyond that drift. |
| **Net-asset redemptions** | Shares are priced on `assets − reserved_payouts` for both deposits and withdrawals. | An underwriter who exits while a claim is staged takes their pro-rata share of that pending loss with them, instead of leaving it to the LPs who stay. |
| **Registrable-domain cap** | The 20% per-host cap is keyed by eTLD+1 (`a.node.io`, `b.node.io` and `c.node.io` share one cap). Platform suffixes such as `*.vercel.app` and `*.github.io` count each tenant separately. | Cycling subdomains does not bypass the cap. |
| **Claim velocity ceiling** | Payouts per 24 h epoch are capped at 30% of pool assets. The first payout of an epoch is always allowed. Blocked claims stay staged and reserved. | Simultaneous breaches are paid over several epochs, never in one step. The queue always drains, and the 14-day settlement window outlasts it. |

**Concentration caps** (percent of pool assets): 10% per policy, 20% per registrable domain, 20% per holder, 80% total utilization. Reserved capital cannot be withdrawn by underwriters.

### Economic assumptions and known limitations

These are disclosed on purpose. The safeguards above **bound and slow** the losses described here; they do not remove them.

1. **Operator self-collusion is bounded, not eliminated.** An operator who controls several endpoints, on different registrable domains, and buys policies from several fresh addresses can, after the 7-day vesting period, stage claims by taking those endpoints down. In aggregate this can extract **up to the pool's 80% maximum utilization cap**. The mechanics that limit it are the per-policy (10%), per-domain (20%) and per-holder (20%) caps, the 3-failure-plus-grace rule, and the claim velocity ceiling, which spreads payouts over several epochs. Staged claims are public on-chain for the whole grace period, so underwriters can see the pressure building. The attacker still pays premiums and bears the cost of their own downtime. At the current parameters, however, a fully vested payout (100% of coverage) can exceed those costs. The parameters (caps, vesting length, premium rates) are the primary defence and are set at deployment or in the contract source, and **underwriters should size liquidity buffers with this scenario in mind**. The protocol has no identity layer, so it cannot tell fresh addresses apart from independent customers.
2. **Uptime is measured from transaction-triggered samples, not continuous monitoring.** There is no centralized pinger and no wall-clock heartbeat. A probe happens only when someone calls `trigger_probe`, no more often than the policy's interval. Reported uptime is the ratio of healthy to total samples in a 30-day window, and is not time-weighted. An outage that falls between probes is invisible. If nobody probes, nothing is detected. The incentive to probe is the refunded bond when a failure is found, plus underwriters' and policyholders' own interest in running keepers.
3. **Latency is not enforced on-chain** (see §6).
4. **Redemptions are priced conservatively.** Shares redeem at assets minus the *full* reserved coverage. If a staged claim is later dismissed, or pays less than full coverage because of vesting, the difference accrues to the LPs who stayed, not to those who exited meanwhile.
5. **The 10-block drift bound assumes moderate block times.** On very fast chains, validators measuring a few seconds apart can differ by more than 10 blocks. Probes on such endpoints may fail to reach consensus and be retried.
6. **Domain grouping is an approximation.** A full Public Suffix List cannot be embedded in a contract. The contract uses the last two labels plus a built-in list of common multi-label and hosting-platform suffixes.
7. **Payouts can be delayed by the velocity ceiling.** In a mass-breach event a claim may wait several epochs. The first claim of each epoch is guaranteed.
8. Validators are assumed to be honest-majority, as in all GenLayer contracts.

## 4. Specification

### Contract

- **Language and runtime:** Python on GenVM v0.3, strictly typed public signatures. Storage uses `TreeMap`, `DynArray` and `@allow_storage` dataclasses. Amounts are atto-GEN (`value × 10¹⁸`) held in `u256`. Payouts and refunds use `emit_transfer`.
- **Consensus:** `gl.vm.run_nondet(leader, validator)`. The validator rejects malformed or self-contradicting leader results (for example, "healthy" with status 502), and tolerates a latency-only disagreement within ±20% of the limit.
- **Input safety:** an on-chain SSRF guard accepts only public `http(s)` hosts. It rejects credentials, backslashes, IPv6 literals, hex/decimal/octal IP encodings, private and reserved ranges, internal suffixes and rebinding domains.
- **Errors:** deterministic codes (`[EXPOSURE_CAP]`, `[TOO_SOON]`, `[INVALID_STATE]`, `[INSUFFICIENT_LIQUIDITY]`, `[INVALID_PARAMS]`, `[EXPECTED]`).

### Parameters

| Parameter | Value |
|---|---|
| Minimum deposit / coverage | 0.001 GEN |
| Probe bond (deploy-time) | 0.01 GEN on this deployment |
| Activation delay / claim grace | 60 s / 300 s on this deployment (default 3600 s each) |
| Policy duration | 300 to 2,628,000 blocks (≈ 1 hour to 1 year, 12 s blocks) |
| Probe interval | 5 to 7,200 blocks (≈ 1 minute to 1 day) |
| Max latency / uptime floor | 50 to 30,000 ms / 90.00% to 99.99% |
| Breach rule | 3 consecutive failures, uptime below floor over a 30-day window |
| Settlement window | 14 days after grace, then the claim lapses and `expire_policy` releases the capital |
| Claim velocity | 24 h epochs; payouts capped at 30% of pool assets per epoch (first payout of an epoch always allowed) |
| Block drift bound | ±10 blocks between leader and validator; heights above 2⁵³ are rejected |
| Payout vesting | 25% → 100% linearly over 7 days of policy age |
| Premium floor | 0.10% of coverage |

### Stack

Frontend: Next.js 16, React 19, Tailwind 4, TypeScript, `genlayer-js`. Pages: Underwrite, Marketplace, Sentinel (health, uptime badge, latency chart, validator roll), Incidents (claim and reasoning inspector), About. The dashboard runs live against the deployed contract, or against an in-memory port of the protocol in demo mode.

## 5. Verification: what is proven, and what is not

### Verified

| Check | Result |
|---|---|
| `genvm-lint check` and `typecheck` | **0 errors** |
| Contract tests (`pytest`, genlayer-test direct mode) | **170 passing** |
| Frontend tests (Vitest + React Testing Library) | **387 passing** |
| `npm run typecheck && lint && test && build` | pass |
| Live on-chain verification (Studio Next) | pass (below) |

**Contract tests** cover deposit/withdraw arithmetic and rounding, premium formulas, policy expiry, healthy / HTTP 500-504 / 404 / 429 / unreachable / high-latency / stale-block / bad-payload probes, the real validator function (agreement, disagreement, forged and malformed leader results), staged claims, vesting, dismissal and lapse, the collusion cases above, rejection of unauthorized payouts, the solvency invariant under **eight simultaneous breaches** paid out across epochs, Byzantine-leader block bounds, LP early-exit fairness, apex-domain caps, and claim velocity.

**Frontend tests** include premium parity against **180 quotes generated from the contract itself**, parity of the URL guard with the contract's accepted/rejected lists, an in-memory protocol engine that mirrors the contract's state machine, wallet and protocol hooks, a mocked `genlayer-js` client, and every page.

**Live on-chain verification** (`scripts/verify_live.py`, real transactions on Studio Next): deposited 1 GEN; bought a policy on `https://ethereum-rpc.publicnode.com`; triggered a probe that was decided with `MAJORITY_AGREE` and recorded a healthy result at a real block height; confirmed the incident log, `locked_coverage ≤ tvl`, and consistent status queries.

### Not verified

- **Wallet writes from the browser** (connect, sign, fee estimation via `genlayer-js`) are tested only against a mocked SDK. Live *reads* are verified.
- **A live breach and payout** has not been executed on-chain. That path is covered by the contract tests and `scripts/simulate_outage.py`, not by a live transaction.
- **Latency enforcement** on-chain (see §6).
- `scripts/deploy.py` locates the new contract address in the receipt on a best-effort basis.

## 6. Clock and latency transparency

GenVM exposes no clock to the contract that advances across a web request. On Studio Next, a probe of a live, responsive endpoint recorded `latency_ms = 0`. This held for both `time.perf_counter()` and `gl.vm.trace_time_micro()`. `gl.vm.get_timestamp()` returns wall-clock time in non-deterministic mode but with one-second resolution, which is too coarse to enforce millisecond limits without false breaches.

| Check | On-chain, Studio Next |
|---|---|
| HTTP status must equal 200 | **Enforced** |
| JSON-RPC payload validity (`eth_blockNumber`) | **Enforced** |
| Stale or frozen block height | **Enforced** |
| Unreachable endpoint | **Enforced** |
| Latency versus `max_latency_ms` | **Not enforced.** Measured latency is always 0 ms. |

The latency threshold is stored, quoted and shown in the UI, and the comparison logic is exercised in the direct-test harness, where the clock is patched. On the live network, a slow endpoint that still answers 200 with a valid, advancing block will **not** breach. Latency enforcement requires GenVM to expose a sub-second clock that observes network wait. The limitation is documented in the contract source.

## 7. Quickstart

**Requirements:** Python 3.12, [`uv`](https://docs.astral.sh/uv/), Node.js 20+.

```bash
# Python toolchain
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --prerelease=allow -r requirements.txt
source .venv/bin/activate

# Contract: lint and test
genvm-lint check contracts/uptime_sla.py
python -m pytest tests -q                         # 170 tests

# In-memory end-to-end simulation: seed → policy → degrade → probe → payout
python scripts/simulate_outage.py                 # --scenario flap: node recovers, claim dismissed

# Frontend
cd frontend
npm install
npm run dev -- -p 3001                            # http://localhost:3001
npm run typecheck && npm run lint && npm run test && npm run build
```

The dashboard is **live** by default. Set `NEXT_PUBLIC_PULSESLA_MODE=demo` (see `frontend/.env.example`) for the in-memory simulation with time and endpoint-health controls. Do not run `npm run build` while the dev server is running: both use `frontend/.next`.

### Scripts

| Command | Purpose |
|---|---|
| `python -m scripts.deploy [--network studio-next] [--activation-secs N] [--grace-secs N] [--probe-bond WEI] [--dry-run]` | Lints, deploys, and exports the address and ABI to `deployments/` and `frontend/lib/{generated,contracts}/`. The deployer key comes from `$PULSESLA_PRIVATE_KEY` or a generated, git-ignored `.keys/deployer.key.json`; Studio networks are funded from the faucet. |
| `python scripts/verify_live.py` | Deposit → policy → probe → solvency checks against the deployed contract. |
| `python scripts/simulate_outage.py` | In-memory outage-to-payout simulation using the contract's real leader and validator code. |
| `python scripts/export_parity.py` | Regenerates the contract-computed premium fixtures used by the frontend parity test. |

### Repository layout

```
contracts/uptime_sla.py   the intelligent contract
tests/                    contract tests
scripts/                  deploy · live verification · simulation · parity export
deployments/              address, ABI, receipts, live verification record
frontend/                 Next.js dashboard (app/ · components/ · lib/ · tests/)
```
