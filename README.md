# PulseSLA

### Infrastructure SLAs that pay themselves, on infrastructure nobody can fake.

PulseSLA is parametric downtime insurance for Web3 infrastructure: public RPC providers and the endpoints they operate. Validators measure the insured endpoint **and independent reference providers on the same chain**, reach consensus on whether the endpoint breached its SLA, and the contract releases a vested payout. There are no claim forms, no adjusters and no off-chain arbitration, and no policyholder-supplied URLs.

| | |
|---|---|
| **Network** | GenLayer Studio Next, chain ID `61997` |
| **Source** | [`contracts/uptime_sla.py`](contracts/uptime_sla.py) (v0.4.0), GenVM runner `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| **Previous deployment** | [`0xDFB967aAa3aecFf5600B9BB734D91536a6B9CCD8`](https://explorer-studio-next.genlayer.com/address/0xDFB967aAa3aecFf5600B9BB734D91536a6B9CCD8): the pre-registry build (v0.3.0), **superseded by this source and not a deployment of it** |
| **Records** | [`deployments/studio-next.json`](deployments/studio-next.json), [`deployments/studio-next-verification.json`](deployments/studio-next-verification.json): both describe the previous build |

> **v0.4.0: authenticated-infrastructure build.** This revision answers the hackathon steward's rejection ("a policyholder can insure an endpoint they control, choose the observations that establish a breach, and receive a vested payout without any independent proof"). See [§3 Authenticated Infrastructure & Exploit Mitigation](#3-authenticated-infrastructure--exploit-mitigation). It **has not been deployed yet**: the address above is the earlier build, and the dashboard in `frontend/` still speaks the earlier ABI (see [§6](#6-verification-what-is-proven-and-what-is-not)).
>
> **Breaking changes.** `create_policy(endpoint_id, coverage_amount, duration_blocks, min_uptime_bps, probe_interval_blocks)` replaces the URL/latency/mode signature. `max_latency_ms` and `http` probe mode are gone ([§7](#7-clock-and-latency-transparency)). `settle_claim` now *confirms* a breach and starts vesting; the new `release_payout` pays it out.

---

## Contents

1. [Problem and solution](#1-problem-and-solution)
2. [Architecture and core flow](#2-architecture-and-core-flow)
3. [Authenticated Infrastructure & Exploit Mitigation](#3-authenticated-infrastructure--exploit-mitigation)
4. [Game theory, economic assumptions and residual risks](#4-game-theory-economic-assumptions-and-residual-risks)
5. [Specification](#5-specification)
6. [Verification: what is proven, and what is not](#6-verification-what-is-proven-and-what-is-not)
7. [Clock and latency transparency](#7-clock-and-latency-transparency)
8. [Quickstart, testing and deployment](#8-quickstart-testing-and-deployment)

---

## 1. Problem and solution

**The problem.** Infrastructure providers sell uptime promises. When they break them, remedies depend on trust: the provider's own status page, a support ticket, sometimes legal arbitration. On-chain, the gap is structural. EVM oracles deliver prices and chain events. They cannot answer the question an SLA actually asks: *did this endpoint respond with HTTP 200, a valid payload, and a block height that is still advancing, when the rest of the network could see it do so?*

**The GenLayer solution.** GenVM provides native, consensus-backed web access. A PulseSLA round is a non-deterministic block: the leader requests the insured endpoint and several independent reference endpoints, every validator independently requests them again, and the transaction is accepted only if the validators reach the same verdict. The SLA becomes its own oracle, and settlement becomes a function call.

**The incentive problem this revision solves.** Parametric insurance is only as good as its observations. If the insured party can pick the endpoint, pick the moment and pick the sample, "proof" is a formality. PulseSLA now binds every policy to an authenticated registry listing, corroborates every observation against independent references, and releases payouts only after continuity checks and a vesting schedule.

## 2. Architecture and core flow

Five roles interact with one contract:

| Role | Action | Contract method |
|---|---|---|
| **Governor** (the deployer) | Curates the registry of authenticated provider endpoints | `register_endpoint(…)` · `delist_endpoint(id)` · `transfer_governor(hex)` |
| **Underwriter** | Supplies GEN, earns premiums, absorbs confirmed payouts pro rata | `deposit_underwriting()` · `withdraw_underwriting(amount)` |
| **Policyholder** | Buys cover on a **registered** endpoint with chosen thresholds | `create_policy(endpoint_id, …)` |
| **Challenger** (anyone) | Triggers a corroborated round, settles a staged claim, or releases vested payout | `trigger_probe(id)` · `settle_claim(id)` · `release_payout(id)` |
| **Validators** | Re-measure the target and every reference independently and agree on the verdict | (GenVM consensus) |

```
Governor ── register_endpoint ─▶ ┌──────── authenticated registry ────────┐
   (consensus eth_chainId,       │ id · provider · domain · chain · hash   │
    commitment hash, 24 h delay) └─────────────────┬──────────────────────┘
                                                  │ endpoint_id (never a URL)
Underwriters ── GEN ──▶ ┌──────────────── pool ───▼──────────────────────────┐
Policyholders ─premium─▶│ create_policy ─▶ trigger_probe ─▶ breach staged     │
Challengers ──bond────▶ │  (round = target + ≥3 independent references)       │
                        │       │ HEALTHY / FAILING / INCONCLUSIVE            │
                        │       ▼  ≥3 failing rounds · ≥15 min · ≥25 blocks   │
                        │   settle_claim ─ fresh corroborated round ─▶        │
                        │   BREACH CONFIRMED ─ 24 h cooldown ─ 3 d stream ─▶  │
                        │   release_payout ─▶ holder                          │
                        └─────────────────────────────────────────────────────┘
```

1. **Authenticate.** The governor lists a provider's public, keyless JSON-RPC endpoint. The contract verifies the URL is under the declared registrable domain, checks a commitment hash, and runs a consensus `eth_chainId` call that must equal the declared chain. Listings are immutable.
2. **Underwrite.** Deposits mint pool shares at the current share price. Premiums accrue to the pool. Withdrawals are limited to capital not locked behind live coverage.
3. **Insure.** `create_policy(endpoint_id, coverage_amount, duration_blocks, min_uptime_bps, probe_interval_blocks)`. Two tiers are priced: **Gold** (uptime floor ≥ 99.9%, 8.0%/yr) and **Silver** (≥ 99.0%, 4.0%/yr); lower floors down to 90% are accepted at 2.0%/yr. `quote_premium` returns the exact on-chain price. Overpayment is refunded. The endpoint must be listed, past its listing delay and have at least three independent reference providers on its chain.
4. **Observe.** `trigger_probe` runs a *round*: the insured endpoint plus up to four reference endpoints from other providers on the same chain. The round's verdict is `HEALTHY`, `FAILING` or `INCONCLUSIVE`, and every validator must independently reach the same one.
5. **Stage.** At least three consecutive `FAILING` rounds that together span at least 15 minutes **and** 25 reference-chain blocks (four rounds at a 5-minute cadence, sixteen at a 1-minute cadence), after a corroborated healthy baseline and with time-weighted uptime below the policy floor, stage a claim. The payout is **reserved**, not paid.
6. **Confirm.** After the grace period, `settle_claim` runs a fresh corroborated round. If the endpoint is still `FAILING` the breach is **confirmed** and the payout (age-ramped, velocity-limited) begins vesting. If it is `HEALTHY` the claim is dismissed. If it is `INCONCLUSIVE` nothing changes.
7. **Vest.** Nothing is releasable for 24 h; then the payout streams linearly over 3 days. `release_payout` is permissionless and always pays the **holder**.

**Bonds.** A round or settlement bond is refunded when the round confirms a failure or cannot be corroborated, and forfeited to underwriters when the endpoint is healthy. Pointless probes cost money; useful ones are free.

**Observability.** `get_incidents` returns an append-only log of every listing, policy, round (with verdict, `refs_ok/refs_total`, reference head), breach, dismissal and payout release. `get_pool_metrics`, `get_policy_status`, `get_endpoint`, `get_references`, `get_underwriter` and `list_policies` expose live state.

## 3. Authenticated Infrastructure & Exploit Mitigation

### The review

> *"We cannot accept this submission because a policyholder can insure an endpoint they control, choose the observations that establish a breach, and receive a vested payout without any independent proof of the insured service or outage. Please bind coverage to authenticated infrastructure and use independently corroborated, representative measurements for every enforced SLA metric."*

The review describes a **self-attack**: the insured party is also the insured service. In the earlier build `create_policy` accepted any public URL, so an operator could buy cover on a node it ran, take it down, call `trigger_probe` when it chose, and collect a vested payout. The only "evidence" was the operator's own endpoint answering the validators' requests the way the operator wanted. That is a moral-hazard flaw in the design, not a tunable parameter, so this revision removes the capability rather than pricing it.

### How each element of the attack is closed

| Attack element | Mitigation in v0.4.0 | Where it is enforced | Test that proves it |
|---|---|---|---|
| **Insure an endpoint the holder controls** | There is no URL input. `create_policy` takes an `endpoint_id` that must exist in the governor-curated registry; anything else reverts `[UNAUTHENTICATED_ENDPOINT]`. A listed provider's own URL is not accepted as a handle either. | `create_policy`, `register_endpoint` | `TestMoralHazard::test_an_attempt_to_insure_an_unauthenticated_arbitrary_endpoint_fails`, `TestCreatePolicy::test_unauthenticated_endpoints_cannot_be_insured`, `test_the_legacy_url_signature_is_gone` |
| **Get their own endpoint listed** | Only the governor can list. The governor cannot hold policies. A new listing is neither insurable nor a reference for 24 h, so LPs have a full day to exit if a listing is hostile. | `_only_governor`, `LISTING_DELAY_SECS` | `test_a_holder_cannot_add_their_own_endpoint_to_the_registry`, `test_a_freshly_listed_endpoint_cannot_be_insured_immediately_…`, `test_the_governor_cannot_collect_on_infrastructure_it_lists` |
| **List something that is not what it claims** | A listing must carry `sha256("pulsesla/v1\|id\|provider\|domain\|chain_id\|url")`, the URL must be https, public and under the declared *registrable* domain, and a **consensus `eth_chainId`** must equal the declared chain. Unreachable or garbage endpoints cannot be listed. | `register_endpoint` | `TestRegistry` (16 invalid-listing cases, chain-id mismatch, unreachable endpoint) |
| **Report an outage only the holder can see** | Every round also measures ≥3 *independent* reference providers on the same chain (distinct registrable domains, never the insured provider). If fewer than a strict majority of references answer, the round is `INCONCLUSIVE` and counts for nothing, so an observer-side or localized outage is never attributed to the provider. | `_classify`, `_round` | `test_observer_side_outage_is_inconclusive_…`, `test_a_localized_observation_without_reference_corroboration_is_discarded`, `test_a_provider_outage_correlated_with_the_references_is_not_paid` |
| **Forge or poison the leader's report** | Validators re-measure the target **and every reference** themselves, recompute the verdict from the leader's raw observations, and require the *same* verdict. The reference set must match exactly (a leader cannot drop an inconvenient reference). Reported heights are bounded against the validator's own reading, so a fabricated reference head cannot manufacture staleness. | `_round_agrees` | `TestValidatorConsensus`, `TestByzantineLeader` |
| **Trigger a payout from one report** | One failing round, even corroborated, stages nothing. A claim needs ≥3 consecutive `FAILING` rounds spanning ≥15 minutes **and** ≥25 blocks of *reference-chain* progress, a grace period, and a fresh corroborated round. `settle_claim` with no staged claim reverts. | `_maybe_stage_breach`, `settle_claim` | `test_a_single_uncorroborated_report_cannot_trigger_an_insurance_payout`, `TestClaims::test_the_outage_must_span_real_reference_chain_progress` |
| **Choose the moment and the sample** | Uptime is time-weighted, not a ratio of the holder's samples: each corroborated failing round counts one probe interval of downtime, against the elapsed window floored at 24 h. Unprobed time counts as *up*. Probing only during failures cannot shrink the denominator. | `_uptime_bps` | `test_uptime_is_judged_on_a_floored_window_…`, `test_unprobed_healthy_history_dilutes_a_short_outage`, `test_a_brief_blip_chosen_by_the_holder_is_not_a_breach` |
| **Induce a "failure" by throttling** | HTTP 429 is `INCONCLUSIVE`, not an outage: throttling is not a representative provider failure. | `_observe`, `_classify` | `test_rate_limit_flooding_cannot_manufacture_a_breach` |
| **Collect a vested payout instantly** | Confirmation moves no funds. The payout is parked as a reserved liability, nothing is releasable for 24 h, then it streams linearly over 3 days. On top of that: age ramp (25%→100% over 7 days), per-epoch ceiling (30% of the pool), and exposure caps. | `_begin_vesting`, `release_payout` | `test_payouts_cannot_instantly_drain_the_pool`, `test_payout_streams_after_a_cooldown_…`, `TestClaimVelocity` |

### The registry: what "authenticated" means, precisely

A listing is **authenticated** because of five independent bindings, each checked by the contract:

1. **Curation.** Only the governor can list or delist. The governor cannot hold policies (`[UNAUTHORIZED]`).
2. **Domain binding.** The URL host must equal, or be a subdomain of, the declared domain, and the declared domain must be a registrable domain (eTLD+1). A provider cannot be impersonated from another domain.
3. **Commitment hash.** The listing carries a SHA-256 over `(id, provider, domain, chain_id, url)`. It is recomputed on-chain (`compute_attestation` exposes it) so anyone can compare it with the provider's own published documentation.
4. **Live chain authentication.** At listing, a consensus `eth_chainId` call must return the declared chain id. An endpoint that serves a different chain, is unreachable, or returns garbage is rejected.
5. **Immutability.** Listings never change after being written; policies snapshot the listing. `delist_endpoint` only stops *new* policies and removes the listing from the reference set.

Endpoints are **public, keyless** JSON-RPC URLs. An API key in a URL is a secret and must never go on-chain; it would also make "the insured endpoint" a per-customer resource. The default manifest (`scripts/register_endpoints.py`) lists PublicNode, Cloudflare, 1RPC and dRPC for Ethereum mainnet, which answered `eth_chainId = 0x1` without a key when this revision was written. Infura, Alchemy and Ankr require an API key for mainnet, so they can be listed only if they expose a keyless gateway.

### The round: representative, corroborated measurement

```
target ──┐
ref 1 ───┤  leader measures all of them        every validator re-measures all of them
ref 2 ───┤  ─▶ raw observations ─▶ _classify   ─▶ same raw → verdict recomputed
ref 3 ───┤                                       ─▶ same verdict required, heights bounded
ref 4 ───┘
```

| Verdict | Condition | Effect |
|---|---|---|
| `HEALTHY` | Strict majority of references healthy, target answers `200` with a valid block, and is within **50 blocks** of the reference head | Streak reset, baseline set, bond forfeited |
| `FAILING` | Strict majority of references healthy, and the target is unreachable / non-200 / invalid payload / more than 50 blocks behind the reference head | Streak +1, one interval of downtime |
| `INCONCLUSIVE` | Fewer than a strict majority of references healthy (the observer is blind or the network is split), or the target answered `429` | **Nothing changes**; bond refunded in full |

The reference head is the **lower median** of the healthy references' heights, so one outlier reference (high or low) cannot move it. Enforced SLA metrics are exactly two, both corroborated: **availability** (HTTP 200 + valid JSON-RPC block number) and **freshness** (block height against the reference head). Latency is no longer enforced ([§7](#7-clock-and-latency-transparency)).

### What this does and does not claim

- **It removes the holder's ability to choose, control or fabricate the evidence.** A holder can still buy cover on a real provider and be paid if *that provider* really fails, as seen by independent validators and independent references.
- **It moves the trust boundary to the registry.** The governor is trusted to list real, independent providers. The mitigations are the 24 h listing delay (an exit window for LPs), immutability, the on-chain `eth_chainId` check, public auditability of every listing and commitment, and the rule that the governor cannot hold policies. A compromised governor key is the main residual risk (§4).
- **It does not make the references infallible.** If most references share a backend with the insured provider, a correlated outage is `INCONCLUSIVE` and unpaid. That is a safe failure for underwriters and a coverage gap for holders (§4).
- **Run `python scripts/simulate_outage.py --scenario attack`** to watch the exploit attempts being refused end to end.

## 4. Game theory, economic assumptions and residual risks

**Attacks considered**, with the safeguard that bounds each:

| Safeguard | Mechanism | Effect |
|---|---|---|
| **Authenticated registry** | See §3. | The insured service is not controlled by the insured party. |
| **Corroborated rounds** | Verdicts require a reference quorum and validator re-measurement. | Localized, observer-side or throttled "outages" never count. |
| **Pre-activation baseline** | Cover cannot be probed during the activation delay, and a claim can stage only after a corroborated healthy round. | Insuring an already-dead node never pays. Instant claims are impossible. |
| **Continuity + grace** | ≥3 consecutive failing rounds over ≥15 min and ≥25 reference blocks, then a grace period and a fresh corroborated round. | A transient glitch or a short blip does not pay. A recovered node cancels the claim. |
| **Time-weighted uptime** | Downtime ÷ window (floored at 24 h); unprobed time counts as up. | Sample selection cannot drive the ratio. |
| **Payout ramp** | Payout is 25% of coverage at policy start rising linearly to 100% over 7 days of policy age. | A freshly bought policy pays at most about a quarter of coverage. |
| **Cooldown + vesting** | 24 h cooldown, then 3 days of linear release; the liability stays reserved, not withdrawable. | No instant drain; time for the community to react to a bad listing. |
| **Solvency invariant** | `owed_payouts ≤ reserved_payouts ≤ locked_coverage ≤ pool_assets` after every operation. | The pool cannot be overdrawn, even if every policy breaches at once. |
| **Claim velocity ceiling** | Confirmations per 24 h epoch are capped at 30% of pool assets. The first of an epoch is always allowed. | Simultaneous breaches are confirmed over several epochs; the queue drains inside the 14-day settlement window. |
| **Rogue-leader bound** | A validator accepts a leader's reported height only if it is at most 2 blocks *ahead* of its own reading and at most 10 behind; non-integer, zero or > 2⁵³ heights are rejected. | A Byzantine leader cannot fabricate lag. |
| **Gross deposits frozen while a claim is staged; net withdrawals** | Deposits are rejected while any claim is *staged*; confirmed payouts are certain liabilities already excluded from net assets and do not freeze deposits. Withdrawals are priced on `assets − reserved`. | No discounted-share arbitrage; an exiting LP takes their share of a pending loss. |
| **Provider-domain cap** | The 20% cap is keyed by registrable domain, shared by every listing under it. | Listing many subdomains does not multiply capacity. |

**Concentration caps** (percent of pool assets): 10% per policy, 20% per provider domain, 20% per holder, 80% total utilization. Reserved and owed capital cannot be withdrawn by underwriters.

### Residual risks (disclosed on purpose)

#### Residual risk 1: registry governance is a trust assumption

The governor decides which endpoints are insurable and which providers count as references. A compromised or malicious governor could list an endpoint it controls and then, from another address, insure it. What stands in the way: the 24 h listing delay (LPs can withdraw all free capital in that window; there is a test for it), the on-chain `eth_chainId` authentication, the commitment hash that makes every listing auditable, the rule that the governor key itself cannot hold policies, the per-policy/provider/holder caps and the payout ramp and vesting. What does *not* stand in the way: the contract cannot prove who operates a domain. Production use should put the governor behind a multisig or DAO and monitor `ENDPOINT_LISTED` incidents. `transfer_governor` exists for that.

#### Residual risk 2: correlated provider outages are unpaid, by design

If a majority of the insured endpoint's references fail at the same time (a cloud-region outage, a shared upstream), the observer cannot tell a provider failure from a network-wide event, the round is `INCONCLUSIVE`, and no claim stages. With four references a round tolerates one failing reference: in the test suite the target plus one other provider failing together still pays; the target plus two others does not. More independent providers in the manifest improve coverage of such events. This is the price of "independently corroborated".

#### Residual risk 3: reference independence is only domain-deep

Independence is enforced at the registrable-domain level. Two domains that front the same backend count as two references. The governor is expected to list genuinely distinct operators; the contract cannot check infrastructure ownership.

#### Residual risk 4: the deposit freeze is a deliberate trade-off

`[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]` applies while any claim is *staged* (grace period plus any wait in the velocity queue, up to the 14-day settlement window in the worst case). It permanently eliminates zero-risk share arbitrage. The earlier griefing vector (a holder who controls the endpoint freezing deposits by staging a claim) is closed by the registry: a holder can no longer cause an outage on an insured endpoint. Withdrawals are never frozen except for capital locked behind coverage or reserved for claims.

#### Residual risk 5: conservative early-exit penalty

An LP who redeems shares during a staged claim absorbs the **full** pending reserved liability, even if the claim is later dismissed or pays less than full coverage. The difference accrues to the LPs who stayed. This is enforced on purpose to prevent front-running withdrawals.

#### Measurement and liveness

- **Rounds come from transactions, not a heartbeat.** A round happens only when someone submits `trigger_probe`, no more often than the policy's interval. An outage between rounds is invisible, and nothing is detected if nobody probes. The incentive to probe is the refunded bond on a found failure and the underwriters' and holders' own interest in running keepers. Because unprobed time counts as *up*, a lazy keeper hurts the holder, never the underwriters.
- **Strict corroboration can reduce liveness.** If a validator's references disagree with the leader's beyond the height bounds (a load-balanced backend 11+ blocks apart), the round is rejected and retried with another leader.
- **Provider-side rate limiting is not an outage.** `429` is `INCONCLUSIVE`, which also means a provider that throttles the validators specifically cannot be claimed against.
- **Domain grouping is an approximation.** A full Public Suffix List cannot be embedded in a contract; the contract uses the last two labels plus a built-in list of common multi-label and hosting-platform suffixes.
- **Single-chain manifest.** Corroboration is per chain id. Each chain needs at least four independent providers listed to be insurable.
- Validators are assumed to be honest-majority, as in all GenLayer contracts.

## 5. Specification

### Contract

- **Language and runtime:** Python on GenVM, strictly typed public signatures. Storage uses `TreeMap`, `DynArray` and `@allow_storage` dataclasses. Amounts are atto-GEN (`value × 10¹⁸`) held in `u256`. Payouts and refunds use `emit_transfer`.
- **Consensus:** `gl.vm.run_nondet(leader, validator)` for rounds and for listing authentication. The validator rejects malformed or self-contradicting leader results, a reference set that differs from the registry's, a verdict its own raw observations do not imply, and any verdict it cannot independently reproduce.
- **Input safety:** governor-listed URLs pass an on-chain SSRF guard (https only, public hosts, no credentials, backslashes, IPv6 literals, numeric-host encodings, private/reserved ranges, internal suffixes, rebinding domains). Policyholders supply no URLs at all.
- **Errors:** deterministic codes (`[UNAUTHENTICATED_ENDPOINT]`, `[REGISTRY_REJECTED]`, `[INCONCLUSIVE]`, `[EXPOSURE_CAP]`, `[VELOCITY_LIMIT]`, `[TOO_SOON]`, `[INVALID_STATE]`, `[INSUFFICIENT_LIQUIDITY]`, `[INVALID_PARAMS]`, `[UNAUTHORIZED]`, `[EXPECTED]`).

### Parameters

| Parameter | Value |
|---|---|
| Minimum deposit / coverage | 0.001 GEN |
| Probe bond (deploy-time) | constructor argument (0.01 GEN by default in `scripts/common.py`) |
| Activation delay / claim grace | constructor arguments (default 3600 s each; immutable) |
| Registry | ≤ 32 listings; listing delay **24 h** (constant) |
| References per round | 3 required, up to 4 used; strict majority must be healthy |
| Staleness tolerance | 50 blocks behind the reference head |
| Policy duration | 300 to 2,628,000 blocks (≈ 1 hour to 1 year, 12 s blocks) |
| Probe interval | 5 to 7,200 blocks (≈ 1 minute to 1 day) |
| Uptime floor | 90.00% to 99.99% |
| Breach rule | ≥ 3 consecutive `FAILING` rounds spanning ≥ 15 min and ≥ 25 reference blocks, uptime below floor |
| Uptime measurement | downtime ÷ max(elapsed, 24 h) over a 30-day window; unprobed time counts as up |
| Settlement window | 14 days after grace, then the claim lapses and `expire_policy` releases the capital |
| Payout ramp | 25% → 100% linearly over 7 days of policy age |
| Payout vesting | 24 h cooldown, then linear over 3 days |
| Claim velocity | 24 h epochs; confirmations capped at 30% of pool assets per epoch (first of an epoch always allowed) |
| Block-height bound | leader ≤ validator + 2 and ≥ validator − 10; heights above 2⁵³ rejected |
| Deposits | priced on net assets; rejected while any claim is staged |
| Premium floor | 0.10% of coverage |

### Stack

Frontend: Next.js 16, React 19, Tailwind 4, TypeScript, `genlayer-js`. Pages: Underwrite, Marketplace, Sentinel, Incidents, About. **The dashboard targets the v0.3.0 ABI and has not been migrated** (§6).

## 6. Verification: what is proven, and what is not

### Verified (this revision)

| Check | Result |
|---|---|
| `genvm-lint check` (lint + GenVM validation) and `genvm-lint typecheck` | **0 errors** (with a GenVM bundle that ships the pinned runner; see §8) |
| Contract tests (`pytest`, genlayer-test direct mode) | **204 passing** |
| `scripts/simulate_outage.py` scenarios `outage`, `flap`, `attack` | all checks pass |
| Test suite sensitivity | removing the reference quorum, the outage-duration/block continuity rule, or the vesting cooldown each makes the adversarial tests fail |

**Contract tests** cover deposit/withdraw arithmetic and rounding, premium formulas, **the registry** (listing validation, commitment hash, chain authentication, listing delay, delisting, reference independence, capacity, governance), policy creation and caps, expiry, **corroborated rounds** (healthy, each HTTP failure, unreachable, rate-limited, stale, malformed payloads, observer-side outage, reference quorum, outlier references), the real validator function (agreement, disagreement, forged/malformed/poisoned leader results, dropped or swapped references), staged claims with continuity rules, **payout vesting** (cooldown, linear release, holder-only payment, solvency), and the **adversarial moral-hazard suite**:

- an attempt to insure an unauthenticated arbitrary endpoint fails;
- a single uncorroborated report cannot trigger an insurance payout;
- authentic outage detection across corroborated validator telemetry succeeds and pays through vesting;
- localized, throttled and correlated "outages" are not paid; probe timing cannot manufacture an uptime breach.

Plus the solvency invariant under simultaneous breach of every policy paid across epochs, Byzantine-leader height bounds, the deposit-arbitrage PoC, LP early-exit fairness, provider-domain caps and claim velocity.

### Not verified

- **Not deployed.** The v0.4.0 source has not been deployed to Studio Next and `deployments/*` still describe the v0.3.0 contract. No live transaction exercises the registry, corroborated rounds or vesting. `scripts/register_endpoints.py` and the updated `scripts/verify_live.py` have not been run against a network.
- **Frontend not migrated.** `frontend/` (and its generated ABI) still uses `create_policy(url, latency, …, mode)`, `max_latency_ms` and the pre-vesting claim flow. Its test suite exercises its own in-memory port of v0.3.0 and was not re-run for this change. A migration needs: the registry listing/selection UI, the new `create_policy` arguments, corroboration fields (`verdict`, `refs_ok`, `ref_head`, `outage_blocks`), the `VESTING` status and `release_payout`, and removal of latency.
- **Live provider behaviour.** The default manifest was checked with plain `eth_chainId` calls only. Real validators' views of those providers, rate limits and height drift have not been observed.
- **Latency enforcement** is removed, not verified (§7).
- `scripts/deploy.py` locates the new contract address in the receipt on a best-effort basis.

## 7. Clock and latency transparency

GenVM exposes no clock to the contract that advances across a web request. On Studio Next the earlier build recorded `latency_ms = 0` for a live, responsive endpoint under both `time.perf_counter()` and `gl.vm.trace_time_micro()`; `gl.vm.get_timestamp()` has one-second resolution, too coarse to enforce millisecond limits. Beyond that, one vantage point's latency is not a *representative* measurement.

The earlier build therefore stored and quoted `max_latency_ms` while enforcing nothing. The steward asked for corroborated, representative measurements for *every enforced* metric, so v0.4.0 **removes latency as a policy parameter** instead of leaving an unenforceable promise in the ABI.

| Check | On-chain |
|---|---|
| Availability: HTTP 200 and a valid JSON-RPC block number | **Enforced**, corroborated |
| Freshness: block height within 50 blocks of the reference head | **Enforced**, corroborated |
| Latency | **Not offered.** Needs a sub-second clock that observes network wait *and* a multi-vantage definition. |

## 8. Quickstart, testing and deployment

**Requirements:** Python 3.12, [`uv`](https://docs.astral.sh/uv/), Node.js 20+ (frontend only).

### Test the contract

```bash
# Python toolchain
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --prerelease=allow -r requirements.txt
source .venv/bin/activate

# The pinned runner (py-genlayer:5jycge…) ships in GenVM bundles up to v0.6.0-rc8.
# tests/conftest.py auto-selects a cached bundle that has it. genvm-lint and the
# scripts follow GENVM_VERSION, so export it if the newest release lacks the runner:
export GENVM_VERSION=v0.6.0-rc8

genvm-lint check contracts/uptime_sla.py          # lint + GenVM validation
genvm-lint typecheck contracts/uptime_sla.py
python -m pytest tests -q                         # 204 tests
python -m pytest tests -q -k "MoralHazard"        # the adversarial suite only

# In-memory end-to-end simulations (the contract's real leader and validator code)
python scripts/simulate_outage.py                      # authentic outage → vested payout
python scripts/simulate_outage.py --scenario flap      # node recovers, claim dismissed
python scripts/simulate_outage.py --scenario attack    # self-attack attempts, all refused
```

### Deploy

The **deployer key becomes the registry governor** and can never hold a policy. Use a distinct key for policyholders (`PULSESLA_HOLDER_KEY`).

```bash
# 1. Deploy (lints first; writes deployments/ and frontend/lib/generated/)
python -m scripts.deploy --network studio-next --activation-secs 60 --grace-secs 300 --probe-bond 10000000000000000
#    (omit the three flags for the 3600 s / 3600 s / 0.01 GEN defaults)

# 2. Populate the authenticated registry as the governor.
python scripts/register_endpoints.py --network studio-next --dry-run   # review manifest + commitments
python scripts/register_endpoints.py --network studio-next
#    Each listing is authenticated by consensus eth_chainId. It becomes
#    insurable, and becomes a reference for others, 24 h after listing
#    (LISTING_DELAY_SECS in the contract). For a short-lived testnet demo you
#    may deploy a build with a smaller constant; keep 24 h for production.

# 3. After the listing delay, verify live (separate holder key; faucet-funded on Studio):
python scripts/verify_live.py --network studio-next --endpoint-id publicnode-eth
```

`python -m scripts.deploy --dry-run` overwrites `deployments/<network>.json` and the frontend's generated ABI with an unaddressed record. Do not run it against a repository whose deployment record you want to keep.

### Frontend

```bash
cd frontend
npm install
npm run dev -- -p 3001                            # http://localhost:3001
npm run typecheck && npm run lint && npm run test && npm run build
```

The dashboard is **live** by default against the address in `frontend/lib/generated/deployment.json`. Set `NEXT_PUBLIC_PULSESLA_MODE=demo` for the in-memory simulation. As noted in §6, it has not been migrated to the v0.4.0 ABI. Do not run `npm run build` while the dev server is running: both use `frontend/.next`.

### Scripts

| Command | Purpose |
|---|---|
| `python -m scripts.deploy [--network studio-next] [--activation-secs N] [--grace-secs N] [--probe-bond WEI] [--dry-run]` | Lints, deploys, and exports the address and ABI. The deployer key (= registry governor) comes from `$PULSESLA_PRIVATE_KEY` or a generated, git-ignored `.keys/deployer.key.json`. |
| `python scripts/register_endpoints.py [--network …] [--dry-run]` | Governor-only. Lists the curated provider manifest; recomputes and cross-checks each commitment hash. |
| `python scripts/verify_live.py [--network …] [--endpoint-id ID]` | Registry → deposit → policy → corroborated probe → solvency checks against the deployed contract, signed by a separate holder key. |
| `python scripts/simulate_outage.py [--scenario outage\|flap\|attack]` | In-memory simulation using the contract's real leader and validator code. |
| `python scripts/export_parity.py` | Regenerates the contract-computed premium fixtures used by the frontend parity test. |

### Repository layout

```
contracts/uptime_sla.py   the intelligent contract (registry · corroboration · vesting)
tests/                    contract tests (conftest.py: simulated multi-provider network)
scripts/                  deploy · register endpoints · live verification · simulation · parity export
deployments/              address, ABI, receipts (v0.3.0 records, pending redeploy)
frontend/                 Next.js dashboard (targets v0.3.0, pending migration)
```
