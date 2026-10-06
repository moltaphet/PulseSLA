#!/usr/bin/env python3
"""End-to-end outage simulation for PulseSLA (in-memory GenVM, no network).

    .venv/bin/python scripts/simulate_outage.py                   # full outage -> automated payout
    .venv/bin/python scripts/simulate_outage.py --scenario flap   # node recovers during the grace period

Story: two underwriters seed the pool; an infrastructure team buys a Gold SLA
policy on its RPC node; the node runs healthy for ten days; then it degrades
(slow -> 502 -> 504 -> dead). A permissionless challenger posts a bond and
triggers probes; validators' web consensus (here: the contract's real leader and
validator functions, run by the genlayer-test direct VM against a scripted RPC)
confirms three consecutive failures, the claim is staged, the grace period
elapses, a second consensus round re-verifies, and the payout is released with no
human in the loop. Every claim the script makes is asserted; exit status is
non-zero if any check fails.
"""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GEN = 10**18
PROBE_BOND = 10**16
ACTIVATION, GRACE = 3600, 600
DAY = 86400
ENDPOINT = "https://rpc.acme-infra.io"

# phase -> (HTTP status | None for no response, latency ms, advances block?)
PHASES = {
    "HEALTHY": (200, 85, True),
    "SLOW": (200, 2400, True),
    "BAD_GATEWAY": (502, 40, False),
    "GATEWAY_TIMEOUT": (504, 30000, False),
    "FROZEN": (200, 90, False),
    "DOWN": (None, 0, False),
    "RECOVERED": (200, 70, True),
}

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
    def __init__(self, vm, contract, patch_targets):
        self.vm, self.c = vm, contract
        self.t = 1_800_000_000
        self.block = 21_000_000
        self.latency = 85
        self.transfers: list[tuple[str, int]] = []
        self.names: dict[str, str] = {}
        self._ticks = 0
        chain, time_mod = patch_targets
        chain.Account.emit_transfer = lambda acct, amt, *, on="finalized": self.transfers.append(
            (acct.address.as_hex.lower(), int(amt)))

        def clock():
            self._ticks += 1
            base = 1000.0 * self._ticks
            return base if self._ticks % 2 else base - 1000.0 + (self.latency + 0.5) / 1000.0

        time_mod.perf_counter = clock
        vm.warp(self.iso())

    def iso(self) -> str:
        return datetime.fromtimestamp(self.t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def advance(self, secs: int) -> None:
        self.t += secs
        self.vm.warp(self.iso())

    def who(self, name: str, addr) -> None:
        self.vm.sender = addr
        self.names[self.c.whoami().lower()] = name

    def phase(self, name: str) -> None:
        status, latency, advances = PHASES[name]
        self.latency = latency
        if advances:
            self.block += 1
        self.vm.clear_mocks()
        self.vm.strict_mocks = status is None  # no mock + strict => request raises => UNREACHABLE
        if status is not None:
            self.vm.mock_web(r".*", {"method": "POST", "status": status,
                                     "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(self.block)})})

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
    vm.sender = create_address("deployer")
    with vm.activate():
        contract = deploy_contract(ROOT / "contracts" / "uptime_sla.py", vm, ACTIVATION, GRACE, PROBE_BOND)
        import genlayer.chain as chain  # importable only once a contract is loaded

        saved = (chain.Account.emit_transfer, time.perf_counter)
        sim = Sim(vm, contract, (chain, time))
        try:
            return _scenario(sim, vm, create_address, scenario)
        finally:
            chain.Account.emit_transfer, time.perf_counter = saved


def _scenario(sim: Sim, vm, addr, scenario: str) -> int:
    c = sim.c
    uw1, uw2, operator, bot = (addr(n) for n in ("underwriter-1", "underwriter-2", "acme-operator", "challenger-bot"))
    for name, a in (("underwriter-1", uw1), ("underwriter-2", uw2), ("acme-operator", operator), ("challenger-bot", bot)):
        vm.deal(a, 1_000 * GEN)
        sim.who(name, a)

    # ---------------------------------------------------------------- 1. liquidity
    banner("1. Seed underwriting liquidity")
    sim.call(uw1, "deposit_underwriting", value=60 * GEN)
    sim.call(uw2, "deposit_underwriting", value=40 * GEN)
    m = c.get_pool_metrics()
    print(f"    pool TVL {gen(m['tvl'])} | share price {int(m['share_price']) / GEN:.4f} | utilization {m['utilization_bps'] / 100:.2f}%")
    check("pool holds 100 GEN, solvent", m["tvl"] == str(100 * GEN) and m["solvent"])

    # ---------------------------------------------------------------- 2. policy
    banner("2. Infrastructure team buys a Gold SLA policy")
    coverage, blocks = 8 * GEN, 200_000
    premium = int(c.quote_premium(coverage, blocks, 9990))
    pid = sim.call(operator, "create_policy", ENDPOINT, 500, coverage, blocks, 9990, 5, "rpc", value=premium)
    p = c.get_policy_status(pid)
    print(f"    policy #{pid}: {ENDPOINT} | SLA 99.90% / 500ms / probe every {p['probe_interval']}s")
    print(f"    coverage {gen(coverage)} | premium {gen(premium)} | cover starts after {ACTIVATION}s activation delay")
    check("premium credited to the pool", c.get_pool_metrics()["tvl"] == str(100 * GEN + premium))
    check("coverage locked", c.get_pool_metrics()["locked_coverage"] == str(coverage))
    sim.phase("HEALTHY")
    with vm.expect_revert("[TOO_SOON]"):
        sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
    check("probes rejected during the activation delay (anti-collusion)", True)

    # ---------------------------------------------------------------- 3. healthy period
    banner("3. Ten healthy days (baseline established)")
    sim.advance(ACTIVATION + 1)
    for day in range(5):
        sim.phase("HEALTHY")
        r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
        print(f"    day {day * 2:>2}: {r['reason']:<10} HTTP {r['status']} {r['latency_ms']:>5}ms block {r['block']}")
        sim.advance(2 * DAY)
    p = c.get_policy_status(pid)
    check("healthy baseline recorded", p["baseline_ok"] and p["samples_ok"] == 5)

    # ---------------------------------------------------------------- 4. degradation
    banner("4. RPC degradation -> validator consensus -> staged claim")
    outage = ["SLOW", "BAD_GATEWAY", "GATEWAY_TIMEOUT"] if scenario == "outage" else ["SLOW", "BAD_GATEWAY", "DOWN"]
    staged = False
    for ph in outage:
        sim.phase(ph)
        r = sim.call(bot, "trigger_probe", pid, value=PROBE_BOND)
        # the contract's real validator, re-executed against the same observation
        agreed = vm.run_validator()
        print(f"    {ph:<16} -> {r['reason']:<12} HTTP {r['status']:<3} {r['latency_ms']:>5}ms | "
              f"validator {'AGREES' if agreed else 'DISAGREES'} | streak {r['consecutive_failures']} | uptime {r['uptime_bps'] / 100:.2f}%")
        check(f"validator consensus on {ph}", agreed)
        staged = r["breach_staged"]
        sim.advance(61)
    p = c.get_policy_status(pid)
    check("claim staged after 3 consecutive failures", staged and p["status"] == "BREACH_PENDING")
    m = c.get_pool_metrics()
    print(f"    payout reserved: {gen(m['reserved_payouts'])} of {gen(m['tvl'])} TVL")
    check("payout earmarked, pool still solvent", m["reserved_payouts"] == str(coverage) and m["solvent"])

    # ---------------------------------------------------------------- 5. guards
    banner("5. Guards during the grace period")
    with vm.expect_revert("[TOO_SOON]"):
        sim.call(operator, "settle_claim", pid, value=PROBE_BOND)
    check("operator cannot settle before the grace period ends", True)
    free = int(m["free_liquidity"])
    with vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
        sim.call(uw1, "withdraw_underwriting", free + 1)
    check("underwriters cannot withdraw the reserved capital", True)

    # ---------------------------------------------------------------- 6. settlement
    banner("6. Grace period elapses -> re-verification -> settlement")
    sim.advance(GRACE + 1)
    sim.phase("DOWN" if scenario == "outage" else "RECOVERED")
    tvl_before = int(c.get_pool_metrics()["tvl"])
    sim.transfers.clear()
    r = sim.call(bot, "settle_claim", pid, value=PROBE_BOND)
    print(f"    re-verification: paid={r['paid']} reason={r['reason']}")
    p = c.get_policy_status(pid)
    m = c.get_pool_metrics()
    if scenario == "outage":
        paid = sim.paid_to(operator)
        check("claim PAID automatically", r["paid"] and p["status"] == "PAID")
        check("holder received the full vested coverage", paid == coverage, f"{gen(paid)} of {gen(coverage)}")
        check("pool TVL fell by exactly the payout", int(m["tvl"]) == tvl_before - coverage)
        check("settler's bond returned", sim.paid_to(bot) >= PROBE_BOND)
        check("lock and reservation released", m["locked_coverage"] == "0" and m["reserved_payouts"] == "0")
    else:
        check("claim dismissed, no payout", (not r["paid"]) and p["status"] == "ACTIVE" and sim.paid_to(operator) == 0)
        check("reservation released, cover still locked", m["reserved_payouts"] == "0" and m["locked_coverage"] == str(coverage))
    check("pool solvent (locked <= assets)", m["solvent"] and int(m["locked_coverage"]) <= int(m["tvl"]))

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
    ap.add_argument("--scenario", choices=["outage", "flap"], default="outage")
    sys.exit(run(ap.parse_args().scenario))


if __name__ == "__main__":
    main()
