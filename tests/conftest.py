"""Shared fixtures for the PulseSLA contract suite (genlayer-test direct mode).

`Env` wraps the direct VM with the three things every scenario needs and the
harness does not provide:

  * a controllable clock        -- `env.advance(seconds)` warps the block clock;
  * a mocked JSON-RPC endpoint  -- `env.rpc(...)`, `env.http(...)`, `env.down()`;
  * a transfer ledger           -- the harness silently swallows emit_transfer, so
                                   `genlayer.chain.Account.emit_transfer` is
                                   patched to record (recipient, amount).

Latency is simulated by patching `time.perf_counter`: `_measure` reads it exactly
twice per observation, so the fake returns a start/end pair `latency_ms` apart.
"""

import json
import os
import time
from datetime import datetime, timezone

import pytest

# Every direct deploy asks the GitHub API which GenVM release is newest (a
# network round trip, rate-limited to a 403 anonymously). When a bundle is
# already cached, pin it so the suite is hermetic and ~10x faster.
try:
    from gltest.direct.sdk_loader import GENVM_VERSION_ENV, list_cached_versions

    _cached = list_cached_versions()
    if _cached:
        os.environ.setdefault(GENVM_VERSION_ENV, _cached[0])
except Exception:  # pragma: no cover - fresh machine: fall back to normal resolution
    pass

CONTRACT = "contracts/uptime_sla.py"
ATTO = 10**18
PROBE_BOND = 10**16
ACTIVATION = 3600
GRACE = 600
URL = "https://rpc.node-alpha.io"
T0 = 1_800_000_000  # fixed base so every test is deterministic


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Env:
    def __init__(self, vm, deploy, alice, bob, charlie, owner, accounts, monkeypatch):
        self.vm = vm
        self._deploy = deploy
        self.alice, self.bob, self.charlie, self.owner = alice, bob, charlie, owner
        self.accounts = accounts
        self.now = T0
        self.latency_ms = 20
        self.transfers: list[tuple[str, int]] = []
        self.contract = None
        self._ticks = 0
        vm.strict_mocks = False
        vm.warp(iso(self.now))

        self._mp = monkeypatch

    # ---- deployment & identity -------------------------------------------
    def _install_patches(self) -> None:
        """The SDK is only importable once a contract has been deployed."""
        import genlayer.chain as chain

        def fake_transfer(account, amount, *, on="finalized"):
            self.transfers.append((account.address.as_hex.lower(), int(amount)))

        self._mp.setattr(chain.Account, "emit_transfer", fake_transfer)

        def fake_clock():
            self._ticks += 1
            base = 1000.0 * self._ticks
            # +0.5ms keeps int(seconds * 1000) from truncating 500.99999 to 500
            return base if self._ticks % 2 == 1 else base - 1000.0 + (self.latency_ms + 0.5) / 1000.0

        self._mp.setattr(time, "perf_counter", fake_clock)

    def deploy(self, activation=ACTIVATION, grace=GRACE, bond=PROBE_BOND):
        self.contract = self._deploy(CONTRACT, activation, grace, bond)
        self._install_patches()
        return self.contract

    def hex(self, who) -> str:
        prev = self.vm.sender
        self.vm.sender = who
        h = self.contract.whoami().lower()
        self.vm.sender = prev
        return h

    def distinct_holders(self, n: int) -> list:
        """n addresses with distinct hex identities, none of them the underwriter."""
        seen, out = {self.hex(self.owner)}, []
        for a in [self.alice, self.bob, self.charlie, *self.accounts]:
            h = self.hex(a)
            if h not in seen:
                seen.add(h)
                out.append(a)
            if len(out) == n:
                break
        assert len(out) == n
        return out

    def paid_to(self, who) -> int:
        h = self.hex(who)
        return sum(a for to, a in self.transfers if to == h)

    # ---- clock -------------------------------------------------------------
    def advance(self, seconds: int) -> None:
        self.now += int(seconds)
        self.vm.warp(iso(self.now))

    # ---- endpoint mocks ------------------------------------------------------
    def rpc(self, block: int = 100, status: int = 200, body: str | None = None) -> None:
        self.vm.clear_mocks()
        payload = body if body is not None else json.dumps(
            {"jsonrpc": "2.0", "id": 1, "result": hex(block)}
        )
        self.vm.mock_web(r".*", {"method": "POST", "status": status, "body": payload})

    def http(self, status: int = 200, body: str = "ok") -> None:
        self.vm.clear_mocks()
        self.vm.mock_web(r".*", {"method": "GET", "status": status, "body": body})

    def down(self) -> None:
        """No mock registered + strict mode: the request raises -> UNREACHABLE."""
        self.vm.clear_mocks()
        self.vm.strict_mocks = True

    def up(self) -> None:
        self.vm.strict_mocks = False

    # ---- actions -----------------------------------------------------------
    def fund(self, who, amount=10**24):
        self.vm.deal(who, amount)

    def deposit(self, who, amount):
        self.fund(who)
        self.vm.sender, self.vm.value = who, amount
        out = self.contract.deposit_underwriting()
        self.vm.value = 0
        return out

    def withdraw(self, who, amount):
        self.vm.sender, self.vm.value = who, 0
        return self.contract.withdraw_underwriting(amount)

    def quote(self, coverage=5 * ATTO, blocks=100_000, uptime=9990):
        return int(self.contract.quote_premium(coverage, blocks, uptime))

    def create(self, who, url=URL, latency=500, coverage=5 * ATTO, blocks=100_000,
               uptime=9990, interval=5, mode="rpc", value=None):
        self.fund(who)
        if value is None:
            value = self.quote(coverage, blocks, uptime)
        self.vm.sender, self.vm.value = who, value
        pid = self.contract.create_policy(url, latency, coverage, blocks, uptime, interval, mode)
        self.vm.value = 0
        return pid

    def probe(self, pid, who=None, bond=PROBE_BOND):
        self.fund(who or self.charlie)
        self.vm.sender, self.vm.value = who or self.charlie, bond
        out = self.contract.trigger_probe(pid)
        self.vm.value = 0
        return out

    def settle(self, pid, who=None, bond=PROBE_BOND):
        self.fund(who or self.charlie)
        self.vm.sender, self.vm.value = who or self.charlie, bond
        out = self.contract.settle_claim(pid)
        self.vm.value = 0
        return out

    def next_probe(self, pid, who=None):
        """Advance past the probe interval, then probe."""
        self.advance(61)
        return self.probe(pid, who)

    def metrics(self) -> dict:
        return self.contract.get_pool_metrics()

    def policy(self, pid) -> dict:
        return self.contract.get_policy_status(pid)

    def activate(self):
        self.advance(ACTIVATION + 1)

    def stage_breach(self, pid, block=100):
        """Healthy baseline, then three consecutive failing probes."""
        self.activate()
        self.rpc(block)
        assert self.probe(pid)["ok"]
        self.rpc(status=502)
        last = None
        for _ in range(3):
            last = self.next_probe(pid)
        return last

    def assert_solvent(self):
        m = self.metrics()
        assert m["solvent"]
        assert int(m["locked_coverage"]) <= int(m["tvl"])
        assert int(m["reserved_payouts"]) <= int(m["locked_coverage"])


@pytest.fixture
def env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch):
    e = Env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch)
    e.deploy()
    return e


@pytest.fixture
def funded(env):
    """Pool seeded with 100 GEN by `owner` (the underwriter)."""
    env.deposit(env.owner, 100 * ATTO)
    return env
