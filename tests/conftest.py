"""Shared fixtures for the PulseSLA contract suite (genlayer-test direct mode).

`Env` wraps the direct VM with what every scenario needs and the harness does
not provide:

  * a controllable clock        -- `env.advance(seconds)` warps the block clock;
  * a simulated JSON-RPC network -- every registry host is mocked individually:
        the INSURED endpoint follows `env.target` and a per-test *spec*, every
        other listed provider serves the shared network head (which advances
        with the clock, one block per 12 s) unless overridden;
  * a transfer ledger           -- the harness silently swallows emit_transfer, so
                                   `genlayer.chain.Account.emit_transfer` is
                                   patched to record (recipient, amount);
  * an authenticated registry   -- six providers listed by the governor
                                   (`owner`) and aged past the listing delay.

Endpoint specs (`env.mock(target=..., refs=...)`):
    "head"            healthy, serving the current network head
    <int>             healthy at exactly that height
    ("lag", n)        healthy but n blocks behind the network head
    ("status", 502)   HTTP error
    ("body", text)    HTTP 200 with a raw body (malformed payloads)
    "down"            unreachable (connection error)
"""

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

CONTRACT = "contracts/uptime_sla.py"


def _pin_genvm_version() -> None:
    """Direct deploys ask the GitHub API which GenVM release is newest (a network
    round trip, rate-limited to a 403 anonymously). Pin a CACHED bundle that
    actually ships the runner this contract depends on, so the suite is
    hermetic and ~10x faster. An explicit GENVM_VERSION always wins."""
    try:
        from gltest.direct.sdk_loader import CACHE_DIR, GENVM_VERSION_ENV, list_cached_versions

        if os.environ.get(GENVM_VERSION_ENV):
            return
        header = Path(CONTRACT).read_text().split("\n", 3)[:3]
        match = re.search(r"py-genlayer:([0-9a-z]+)", "\n".join(header))
        for version in list_cached_versions():
            runners = Path(CACHE_DIR) / "trees-v2" / version / "runners" / "py-genlayer"
            if not match or (runners / match.group(1)[:2]).exists():
                os.environ[GENVM_VERSION_ENV] = version
                return
    except Exception:  # pragma: no cover - fresh machine: fall back to normal resolution
        pass


_pin_genvm_version()

ATTO = 10**18
PROBE_BOND = 10**16
ACTIVATION = 3600
GRACE = 600
T0 = 1_800_000_000  # fixed base so every test is deterministic
HEAD0 = 20_000_000  # network head at T0
BLOCK_SECS = 12
LISTING_DELAY = 24 * 3600
CHAIN_ID = 1

# Six independent providers on chain 1. Each is insurable and each is a
# reference for the others (the contract picks the first four distinct
# providers other than the insured one).
PROVIDERS = [
    ("alpha-rpc", "Alpha Nodes", "node-alpha.io"),
    ("beta-rpc", "Beta Nodes", "node-beta.io"),
    ("gamma-rpc", "Gamma Nodes", "node-gamma.io"),
    ("delta-rpc", "Delta Nodes", "node-delta.io"),
    ("epsilon-rpc", "Epsilon Nodes", "node-epsilon.io"),
    ("zeta-rpc", "Zeta Nodes", "node-zeta.io"),
]
ALPHA = "alpha-rpc"


def url_of(endpoint_id: str) -> str:
    domain = {i: d for i, _, d in PROVIDERS}[endpoint_id]
    return f"https://rpc.{domain}"


def attest(endpoint_id: str, provider: str, domain: str, chain_id: int, url: str) -> str:
    return hashlib.sha256(f"pulsesla/v1|{endpoint_id}|{provider}|{domain}|{chain_id}|{url}".encode()).hexdigest()


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Env:
    def __init__(self, vm, deploy, alice, bob, charlie, owner, accounts, monkeypatch):
        self.vm = vm
        self._deploy = deploy
        self.alice, self.bob, self.charlie, self.owner = alice, bob, charlie, owner
        self.accounts = accounts
        self.now = T0
        self.transfers: list[tuple[str, int]] = []
        self.contract = None
        self.target = ALPHA  # the endpoint `fail()` / `mock(target=...)` degrade by default
        self.overrides: dict = {}  # endpoint_id -> spec
        self.default_spec = "head"  # every provider without an override
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

    def deploy(self, activation=ACTIVATION, grace=GRACE, bond=PROBE_BOND, registry=True):
        self.vm.sender = self.owner  # the deployer becomes the registry governor
        self.contract = self._deploy(CONTRACT, activation, grace, bond)
        self._install_patches()
        if registry:
            self.bootstrap_registry()
        return self.contract

    def hex(self, who) -> str:
        prev = self.vm.sender
        self.vm.sender = who
        h = self.contract.whoami().lower()
        self.vm.sender = prev
        return h

    def distinct_holders(self, n: int) -> list:
        """n addresses with distinct hex identities, none of them the underwriter/governor."""
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

    # ---- clock & network ----------------------------------------------------
    @property
    def head(self) -> int:
        """Network head: advances one block per 12 s of block-clock time."""
        return HEAD0 + (self.now - T0) // BLOCK_SECS

    def advance(self, seconds: int) -> None:
        self.now += int(seconds)
        self.vm.warp(iso(self.now))
        self._apply()  # the network moved on: re-publish heights

    def _resolve(self, spec) -> dict | None:
        """spec -> mock response, or None for 'unreachable'."""
        if spec == "down":
            return None
        if spec == "head":
            return {"status": 200, "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(self.head)})}
        if isinstance(spec, int):
            return {"status": 200, "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(spec)})}
        kind, arg = spec
        if kind == "lag":
            return {"status": 200, "body": json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(self.head - arg)})}
        if kind == "status":
            return {"status": arg, "body": ""}
        if kind == "body":
            return {"status": 200, "body": arg}
        raise AssertionError(f"bad spec {spec!r}")

    def _apply(self) -> None:
        self.vm.strict_mocks = False  # clear without "never matched" noise
        self.vm.clear_mocks()
        self.vm.strict_mocks = True  # an unmocked host raises -> UNREACHABLE
        for endpoint_id, _, domain in PROVIDERS:
            resp = self._resolve(self.overrides.get(endpoint_id, self.default_spec))
            if resp is not None:
                self.vm.mock_web(
                    rf"^https://rpc\.{re.escape(domain)}",
                    {"method": "POST", "status": resp["status"], "body": resp["body"]},
                )

    def mock(self, target="head", refs="head", **per_ref) -> None:
        """`target` applies to `env.target`, `refs` to every other provider, and
        `beta_rpc="down"`-style keywords override single providers."""
        self.overrides = {self.target: target}
        self.overrides.update({k.replace("_", "-"): v for k, v in per_ref.items()})
        self.default_spec = refs
        self._apply()

    def mock_many(self, overrides: dict, default="head") -> None:
        """Degrade several providers at once: {endpoint_id: spec}."""
        self.overrides = dict(overrides)
        self.default_spec = default
        self._apply()

    def healthy(self) -> None:
        self.mock("head", "head")

    def fail(self, spec=("status", 502)) -> None:
        """The insured endpoint fails; the rest of the network is healthy."""
        self.mock(spec, "head")

    def blind(self) -> None:
        """Observer-side outage: nothing answers (target and every reference)."""
        self.mock("down", "down")

    # ---- registry -------------------------------------------------------------
    def mock_chain_id(self, chain_id: int = CHAIN_ID, status: int = 200, body: str | None = None) -> None:
        self.vm.clear_mocks()
        payload = body if body is not None else json.dumps({"jsonrpc": "2.0", "id": 1, "result": hex(chain_id)})
        self.vm.mock_web(r".*", {"method": "POST", "status": status, "body": payload})

    def register(self, endpoint_id, provider, domain, url=None, chain_id=CHAIN_ID, attestation=None, who=None,
                 mock_chain=None):
        url = url or f"https://rpc.{domain}"
        attestation = attestation or attest(endpoint_id, provider, domain, chain_id, url)
        self.mock_chain_id(CHAIN_ID if mock_chain is None else mock_chain)
        self.vm.sender, self.vm.value = who or self.owner, 0
        return self.contract.register_endpoint(endpoint_id, provider, domain, chain_id, url, attestation)

    def bootstrap_registry(self, n: int | None = None) -> None:
        for endpoint_id, provider, domain in PROVIDERS[: n or len(PROVIDERS)]:
            self.register(endpoint_id, provider, domain)
        self.advance(LISTING_DELAY + 1)
        self.target = ALPHA
        self.healthy()

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

    def create(self, who, endpoint=ALPHA, coverage=5 * ATTO, blocks=100_000, uptime=9990, interval=25, value=None):
        """interval=25 blocks = 300 s between rounds: four failing rounds span
        the 15-minute minimum outage."""
        self.fund(who)
        if value is None:
            value = self.quote(coverage, blocks, uptime)
        self.vm.sender, self.vm.value = who, value
        pid = self.contract.create_policy(endpoint, coverage, blocks, uptime, interval)
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

    def release(self, pid, who=None):
        self.vm.sender, self.vm.value = who or self.charlie, 0
        return self.contract.release_payout(pid)

    def next_probe(self, pid, who=None):
        """Advance past the policy's probe interval, then probe."""
        self.advance(int(self.policy(pid)["probe_interval"]) + 1)
        return self.probe(pid, who)

    def metrics(self) -> dict:
        return self.contract.get_pool_metrics()

    def policy(self, pid) -> dict:
        return self.contract.get_policy_status(pid)

    def activate(self):
        self.advance(ACTIVATION + 1)

    def stage_breach(self, pid, spec=("status", 502), rounds=4):
        """Corroborated healthy baseline, then `rounds` consecutive failing rounds
        (four 5-minute rounds = the 15-minute minimum outage)."""
        self.activate()
        self.healthy()
        assert self.probe(pid)["ok"]
        self.fail(spec)
        last = None
        for _ in range(rounds):
            last = self.next_probe(pid)
        return last

    def assert_solvent(self):
        m = self.metrics()
        assert m["solvent"]
        assert int(m["locked_coverage"]) <= int(m["tvl"])
        assert int(m["reserved_payouts"]) <= int(m["locked_coverage"])
        assert int(m["owed_payouts"]) <= int(m["reserved_payouts"])


@pytest.fixture
def env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch):
    e = Env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch)
    e.deploy()
    return e


@pytest.fixture
def bare(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch):
    """A deployed contract with an EMPTY registry."""
    e = Env(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_owner, direct_accounts, monkeypatch)
    e.deploy(registry=False)
    return e


@pytest.fixture
def funded(env):
    """Registry bootstrapped and pool seeded with 100 GEN by `owner` (the underwriter / governor)."""
    env.deposit(env.owner, 100 * ATTO)
    return env
