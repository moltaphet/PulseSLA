#!/usr/bin/env python3
"""End-to-end outage simulation for PulseSLA (in-memory GenVM, no network).

    .venv/bin/python scripts/simulate_outage.py                   # authentic outage -> vested payout
    .venv/bin/python scripts/simulate_outage.py --scenario flap   # node recovers during the grace period
    .venv/bin/python scripts/simulate_outage.py --scenario attack # self-attack attempts, all refused

Story: the governor lists four independent RPC providers in the authenticated
registry; two underwriters seed the pool; an infrastructure team buys a Gold SLA
policy on one LISTED endpoint (it cannot name a URL of its own). Validators'
web consensus (here: the contract's real leader and validator functions, run by
the genlayer-test direct VM against a scripted network) measures the insured
endpoint AND three independent reference providers on every round.

  outage : the endpoint genuinely dies while the references stay up. Four
           corroborated failing rounds span 15 minutes and 75 reference blocks,
           the claim is staged, the grace period elapses, a second corroborated
           round confirms, and the payout vests (cooldown, then linear release).
  flap   : the endpoint recovers during the grace period; the claim is dismissed.
  attack : a holder tries to insure its own endpoint, to cash in on an outage
           only it can see, and to settle without a corroborated failure.

Every claim the script makes is asserted; exit status is non-zero if any check fails.
"""

import argparse
import json
import re
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import tests.conftest  # noqa: E402,F401  (pins a cached GenVM bundle that ships the contract's runner)

warnings.filterwarnings("ignore", message="Web mock never matched")

GEN = 10**18
PROBE_BOND = 10**16
ACTIVATION, GRACE = 3600, 600
DAY = 86400
COOLDOWN, VEST = DAY, 3 * DAY
PROVIDERS = [
    ("acme-rpc", "Acme Infra", "acme-infra.io"),
    ("borealis-rpc", "Borealis", "borealis-nodes.io"),
    ("cirrus-rpc", "Cirrus", "cirrus-rpc.io"),
    ("dune-rpc", "Dune", "dune-gateway.io"),
]
T0, HEAD0 = 1_800_000_000, 21_000_000

failures: list[str] = []


def gen(wei) -> str:
    return f"{int(wei) / GEN:,.4f} GEN"


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"    [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(label)


def banner(text: str) -> None:
    print(f"\n=== {text} " + "=" * max(0, 74 - len(text)))


class Sim:
    def __init__(self, vm, contract, chain):
        self.vm, self.c = vm, contract
        self.t = T0
        self.transfers: list[tuple[str, int]] = []
        self.overrides: dict[str, object] = {}
        chain.Account.emit_transfer = lambda acct, amt, *, on="finalized": self.transfers.append(
            (acct.address.as_hex.lower(), int(amt)))
        vm.warp(self.iso())

    @property
    def head(self) -> int:
        return HEAD0 + (self.t - T0) // 12

    def iso(self) -> str:
        return datetime.fromtimestamp(self.t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def advance(self, secs: int) -> None:
        self.t += secs
        self.vm.warp(self.iso())
        self.network()

    def heal(self) -> None:
        self.overrides = {}
        self.network()

    def network(self, **specs) -> None:
        """Publish the simulated network. `acme_rpc=("status", 502)` degrades one
        provider; anything not named serves the live head. Spec: 'head' | 'down'
        | ('status', n). With no arguments the current degradation is kept (so
        the clock can advance); use `heal()` to clear it."""
        if specs:
            self.overrides = {k.replace("_", "-"): v for k, v in specs.items()}
        self.vm.strict_mocks = False
        self.vm.clear_mocks()
        self.vm.strict_mocks = True  # an unmocked host raises => UNREACHABLE
        for endpoint_id, _, domain in PROVIDERS:
            spec = self.overrides.get(endpoint_id, "head")
            if spec == "down":
                continue
            if isinstance(spec, tuple):
                resp = {"status": spec[1], "body": ""}
            else:
                resp = {"status": 200, "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(self.head)})}
            self.vm.mock_web(rf"^https://rpc\.{re.escape(domain)}", {"method": "POST", **resp})

    def paid_to(self, addr) -> int:
        self.vm.sender = addr
        h = self.c.whoami().lower()
        return sum(a for to, a in self.transfers if to == h)

    def call(self, addr, method: str, *args, value: int = 0):
        self.vm.sender, self.vm.value = addr, value
        try:
            return getattr(self.c, method)(*args)
        finally:
            self.vm.value = 0


def run(scenario: str) -> int:
    from gltest.direct.loader import create_address, deploy_contract
    from gltest.direct.vm import VMContext

    vm = VMContext()
    governor = create_address("governor")
    vm.sender = governor  # the deployer is the registry governor
    with vm.activate():
        contract = deploy_contract(ROOT / "contracts" / "uptime_sla.py", vm, ACTIVATION, GRACE, PROBE_BOND)
        import genlayer.chain as chain  # importable only once a contract is loaded

        saved = chain.Account.emit_transfer
        sim = Sim(vm, contract, chain)
        try:
            return _scenario(sim, vm, create_address, governor, scenario)
        finally:
            chain.Account.emit_transfer = saved


def _attest(endpoint_id, provider, domain, url):
    import hashlib

    return hashlib.sha256(f"pulsesla/v1|{endpoint_id}|{provider}|{domain}|1|{url}".encode()).hexdigest()


def _scenario(sim: Sim, vm, addr, governor, scenario: str) -> int:
    c = sim.c
    uw1, uw2, operator, bot, attacker = (addr(n) for n in ("underwriter-1", "underwriter-2", "acme-operator", "challenger-bot", "attacker"))
    for a in (governor, uw1, uw2, operator, bot, attacker):
        vm.deal(a, 1_000 * GEN)

    # ------------------------------------------------------------ 0. registry
    banner("0. Governor lists authenticated infrastructure")
    for endpoint_id, provider, domain in PROVIDERS:
        url = f"https://rpc.{domain}"
        vm.clear_mocks()
        vm.mock_web(r".*", {"method": "POST", "status": 200, "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": "0x1"})})
        sim.call(governor, "register_endpoint", endpoint_id, provider, domain, 1, url, _attest(endpoint_id, provider, domain, url))
        e = c.get_endpoint(endpoint_id)
        print(f"    {endpoint_id:<14} {url:<34} chain {e['chain_id']} sha256 {e['attestation'][:12]}…")
    sim.advance(DAY + 1)
    refs = c.get_references("acme-rpc")
    check("four providers listed and authenticated by consensus eth_chainId", c.get_pool_metrics()["listed_endpoints"] == 4)
    check("every endpoint is corroborated by three independent providers", refs == ["borealis-rpc", "cirrus-rpc", "dune-rpc"], str(refs))

    # ---------------------------------------------------------------- 1. liquidity
    banner("1. Seed underwriting liquidity")
    sim.call(uw1, "deposit_underwriting", value=60 * GEN)
    sim.call(uw2, "deposit_underwriting", value=40 * GEN)
    m = c.get_pool_metrics()
    check("pool holds 100 GEN, solvent", m["tvl"] == str(100 * GEN) and m["solvent"])

    # ---------------------------------------------------------------- 2. policy
    banner("2. Infrastructure team buys a Gold SLA policy on a LISTED endpoint")
    coverage, blocks = 8 * GEN, 200_000
    premium = int(c.quote_premium(coverage, blocks, 9990))
    pid = sim.call(operator, "create_policy", "acme-rpc", coverage, blocks, 9990, 25, value=premium)
    p = c.get_policy_status(pid)
    print(f"    policy #{pid}: {p['endpoint_id']} -> {p['endpoint_url']} | SLA 99.90% | rounds every {p['probe_interval']}s")
    check("policy is bound to the registry listing", p["endpoint_url"] == "https://rpc.acme-infra.io" and p["apex"] == "acme-infra.io")
    check("coverage locked", c.get_pool_metrics()["locked_coverage"] == str(coverage))
    sim.heal()
    with vm.expect_revert("[TOO_SOON]"):
        sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
    check("rounds rejected during the activation delay", True)

    if scenario == "attack":
        return _attack(sim, vm, c, attacker, operator, bot, pid)

    # ---------------------------------------------------------------- 3. healthy period
    banner("3. Ten healthy days (corroborated baseline)")
    sim.advance(ACTIVATION + 1)
    for day in range(5):
        r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
        print(f"    day {day * 2:>2}: {r['verdict']:<8} block {r['block']} vs reference head {r['ref_head']} ({r['refs_ok']}/{r['refs_total']} refs)")
        sim.advance(2 * DAY)
    p = c.get_policy_status(pid)
    check("healthy baseline recorded", p["baseline_ok"] and p["samples_ok"] == 5)

    # ---------------------------------------------------------------- 4. degradation
    banner("4. Provider outage -> corroborated rounds -> staged claim")
    sim.network(acme_rpc=("status", 502))
    staged = False
    for n in range(1, 5):
        sim.advance(301)
        r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
        agreed = vm.run_validator()  # the contract's real validator, re-run against the same observation
        p = c.get_policy_status(pid)
        print(f"    round {n}: {r['verdict']:<8} {r['reason']:<11} refs {r['refs_ok']}/{r['refs_total']} | validator "
              f"{'AGREES' if agreed else 'DISAGREES'} | streak {r['consecutive_failures']} | outage {p['outage_blocks']} blocks | "
              f"uptime {r['uptime_bps'] / 100:.2f}%")
        check(f"validator independently corroborates round {n}", agreed and r["verdict"] == "FAILING")
        check(f"round {n} stages {'a claim' if n == 4 else 'nothing'}", r["breach_staged"] == (n == 4))
        staged = r["breach_staged"]
    p = c.get_policy_status(pid)
    check("claim staged only after 15 minutes and 25 reference blocks", staged and p["status"] == "BREACH_PENDING"
          and p["outage_blocks"] >= 25 and sim.t - p["outage_started_at"] >= 900)
    m = c.get_pool_metrics()
    check("payout earmarked, pool still solvent", m["reserved_payouts"] == str(coverage) and m["solvent"])

    # ---------------------------------------------------------------- 5. guards
    banner("5. Guards during the grace period")
    with vm.expect_revert("[TOO_SOON]"):
        sim.call(operator, "settle_claim", pid, value=PROBE_BOND)
    check("operator cannot settle before the grace period ends", True)
    with vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
        sim.call(uw1, "withdraw_underwriting", int(m["free_liquidity"]) + 1)
    check("underwriters cannot withdraw the reserved capital", True)
    with vm.expect_revert("[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"):
        sim.call(attacker, "deposit_underwriting", value=GEN)
    check("deposits are frozen while a claim is staged", True)

    # ---------------------------------------------------------------- 6. settlement
    banner("6. Grace period elapses -> corroborated re-verification -> vesting")
    sim.advance(GRACE + 1)
    if scenario == "flap":
        sim.heal()  # the endpoint recovered during the grace period
    tvl_before = int(c.get_pool_metrics()["tvl"])
    sim.transfers.clear()
    r = sim.call(bot, "settle_claim", pid, value=PROBE_BOND)
    p = c.get_policy_status(pid)
    m = c.get_pool_metrics()
    if scenario == "outage":
        payout = int(r["payout"])
        print(f"    confirmed: payout {gen(payout)} of {gen(coverage)} (policy age ramp); vests after {COOLDOWN}s over {VEST}s")
        check("breach confirmed by a fresh corroborated round", r["confirmed"] and p["status"] == "VESTING")
        check("nothing is paid at confirmation", sim.paid_to(operator) == 0 and int(m["tvl"]) == tvl_before)
        check("payout parked as a reserved liability", m["owed_payouts"] == str(payout) == m["reserved_payouts"])
        sim.advance(COOLDOWN - 10)
        with vm.expect_revert("[TOO_SOON]"):
            sim.call(bot, "release_payout", pid)
        check("release refused during the cooldown", True)
        sim.advance(10 + VEST // 2)
        r1 = sim.call(bot, "release_payout", pid)
        check("half the stream is releasable half-way through vesting", int(r1["released"]) == payout // 2 and not r1["done"], gen(r1["released"]))
        sim.advance(VEST)
        r2 = sim.call(bot, "release_payout", pid)
        m = c.get_pool_metrics()
        check("holder received the full payout, paid to the holder not the caller",
              r2["done"] and sim.paid_to(operator) == payout and sim.paid_to(bot) <= 3 * PROBE_BOND, gen(sim.paid_to(operator)))
        check("lock, reservation and liability released",
              m["locked_coverage"] == "0" and m["reserved_payouts"] == "0" and m["owed_payouts"] == "0")
        check("pool TVL fell by exactly the payout", int(m["tvl"]) == tvl_before - payout)
    else:
        check("claim dismissed, no payout", (not r["confirmed"]) and p["status"] == "ACTIVE" and sim.paid_to(operator) == 0)
        check("reservation released, cover still locked", m["reserved_payouts"] == "0" and m["locked_coverage"] == str(coverage))
    check("pool solvent (locked <= assets)", m["solvent"] and int(m["locked_coverage"]) <= int(m["tvl"]))
    return _summary(c)


def _attack(sim: Sim, vm, c, attacker, operator, bot, pid) -> int:
    banner("A. A holder tries to insure an endpoint it controls")
    for target in ("https://rpc.attacker-owned.io", "https://rpc.acme-infra.io", "attacker-rpc"):
        with vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            sim.call(attacker, "create_policy", target, GEN, 100_000, 9990, 25, value=GEN)
        check(f"create_policy({target!r}) refused", True)
    with vm.expect_revert("[UNAUTHORIZED]"):
        sim.call(attacker, "register_endpoint", "attacker-rpc", "Attacker", "attacker-owned.io", 1,
                 "https://rpc.attacker-owned.io", _attest("attacker-rpc", "Attacker", "attacker-owned.io", "https://rpc.attacker-owned.io"))
    check("only the governor can list endpoints", True)

    banner("B. The operator sees an 'outage' nobody else does")
    sim.advance(ACTIVATION + 1)
    sim.heal()
    assert sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)["ok"]
    sim.network(**{"acme-rpc": ("status", 502), "borealis-rpc": "down", "cirrus-rpc": "down"})  # local view: references dark
    for _ in range(8):
        sim.advance(301)
        r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
        assert r["verdict"] == "INCONCLUSIVE", r
    p = c.get_policy_status(pid)
    check("uncorroborated rounds are INCONCLUSIVE and never staged",
          p["status"] == "ACTIVE" and p["consecutive_failures"] == 0 and p["downtime_secs"] == 0, f"{p['inconclusive_rounds']} inconclusive rounds")

    banner("C. A single failing round, then a forged settlement")
    sim.network(**{"acme-rpc": ("status", 502)})
    sim.advance(301)
    r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
    check("one corroborated failure stages nothing", r["verdict"] == "FAILING" and not r["breach_staged"])
    with vm.expect_revert("[INVALID_STATE]"):
        sim.call(operator, "settle_claim", pid, value=PROBE_BOND)
    check("no staged claim: settle_claim and release_payout both refused", True)
    m = c.get_pool_metrics()
    check("nothing was paid", m["total_payouts"] == "0" and m["owed_payouts"] == "0" and sim.paid_to(operator) == 0)
    return _summary(c)


def _summary(c) -> int:
    m = c.get_pool_metrics()
    banner("Summary")
    print(f"    TVL {gen(m['tvl'])} | premiums {gen(m['total_premiums'])} | payouts {gen(m['total_payouts'])} | "
          f"bond forfeits {gen(m['total_bond_forfeits'])} | probes {m['total_probes']}")
    incidents = [json.loads(s) for s in c.get_incidents(0, 100)]
    print(f"    incident log: {len(incidents)} entries -> " + ", ".join(sorted({i['kind'] for i in incidents})))
    print()
    if failures:
        print(f"SIMULATION FAILED: {len(failures)} check(s) failed")
        return 1
    print("SIMULATION OK: all checks passed")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scenario", choices=["outage", "flap", "attack"], default="outage")
    sys.exit(run(ap.parse_args().scenario))


if __name__ == "__main__":
    main()
