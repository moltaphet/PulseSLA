"""PulseSLA contract tests -- genlayer-test direct mode (in-memory GenVM).

Sections: underwriting arithmetic, premium pricing, the authenticated
infrastructure registry, policy creation & caps, expiry, corroborated probes
(healthy / failing / inconclusive), the real validator rules, staged claims and
payout vesting, the moral-hazard (self-attack) adversarial suite, pool-solvency
invariants, reference-head poisoning, LP early exit, provider-domain caps and
claim velocity.
"""

import hashlib
import json

import pytest

from tests.conftest import ACTIVATION, ALPHA, ATTO, CHAIN_ID, GRACE, LISTING_DELAY, PROBE_BOND, PROVIDERS, attest

YEAR = 365 * 24 * 3600
BLOCKS_PER_YEAR = YEAR // 12
COOLDOWN = 24 * 3600
VEST = 3 * 24 * 3600


def premium_formula(cov: int, blocks: int, uptime: int) -> int:
    rate = 800 if uptime >= 9990 else 400 if uptime >= 9900 else 200
    p = cov * rate * (blocks * 12) // (10000 * YEAR)
    return max(p, cov * 10 // 10000)


def vested(cov: int, age: int) -> int:
    if age >= 7 * 86400:
        return cov
    return cov * (2500 + 7500 * max(age, 0) // (7 * 86400)) // 10000


def classify_like_contract(t_ok, t_reason, t_block, ref_ok, ref_blocks):
    """Independent re-statement of the round verdict used to build leader results."""
    n = len(ref_blocks)
    healthy = sorted(b for ok, b in zip(ref_ok, ref_blocks) if ok and b > 0)
    if n < 3 or len(healthy) < n // 2 + 1:
        return "INCONCLUSIVE", "NO_BASELINE", -1, len(healthy)
    head = healthy[(len(healthy) - 1) // 2]
    if t_ok:
        if t_block + 50 < head:
            return "FAILING", "STALE_BLOCK", head, len(healthy)
        return "HEALTHY", "OK", head, len(healthy)
    if t_reason == "RATE_LIMITED":
        return "INCONCLUSIVE", "RATE_LIMITED", head, len(healthy)
    return "FAILING", t_reason, head, len(healthy)


def leader_round(env, t_block, ref_head=None, *, t_ok=True, t_reason="OK", status=200, ref_ok=None,
                 ref_blocks=None, endpoint=ALPHA):
    """A leader result as an (honest or forged) leader would return it."""
    ids = env.contract.get_references(endpoint)
    ref_ok = ref_ok if ref_ok is not None else [True] * len(ids)
    ref_blocks = ref_blocks if ref_blocks is not None else [ref_head if ref_head is not None else t_block] * len(ids)
    verdict, reason, head, refs_ok = classify_like_contract(t_ok, t_reason, t_block, ref_ok, ref_blocks)
    return {
        "verdict": verdict, "reason": reason, "status": status, "block": t_block, "ref_head": head,
        "refs_ok": refs_ok, "refs_total": len(ids), "t_ok": t_ok, "t_reason": t_reason,
        "refs": [{"id": i, "ok": o, "block": b} for i, o, b in zip(ids, ref_ok, ref_blocks)],
    }


def failing_leader_round(env, ref_head, reason="HTTP_ERROR", status=502):
    return leader_round(env, -1, ref_head, t_ok=False, t_reason=reason, status=status)


# ============================================================================
# Underwriting: deposit / withdraw arithmetic
# ============================================================================
class TestUnderwriting:
    def test_first_deposit_mints_one_to_one(self, env):
        assert env.deposit(env.alice, 100 * ATTO) == str(100 * ATTO)
        m = env.metrics()
        assert m["tvl"] == str(100 * ATTO)
        assert m["total_shares"] == str(100 * ATTO)
        assert m["share_price"] == str(ATTO)
        u = env.contract.get_underwriter(env.hex(env.alice))
        assert (u["shares"], u["value"], u["withdrawable"]) == (str(100 * ATTO),) * 3

    def test_deposit_below_minimum_reverts(self, env):
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.deposit(env.alice, 10**14)

    def test_premium_lifts_share_price_and_later_depositors_get_fewer_shares(self, env):
        env.deposit(env.alice, 100 * ATTO)
        env.create(env.bob, coverage=5 * ATTO)
        premium = env.quote(5 * ATTO)
        assert env.metrics()["tvl"] == str(100 * ATTO + premium)
        assert int(env.metrics()["share_price"]) > ATTO

        minted = int(env.deposit(env.charlie, 50 * ATTO))
        assert minted == 50 * ATTO * (100 * ATTO) // (100 * ATTO + premium)
        assert minted < 50 * ATTO

    def test_withdraw_pays_pro_rata_including_yield(self, env):
        env.deposit(env.alice, 100 * ATTO)
        env.create(env.bob, coverage=5 * ATTO, blocks=300)  # short, premium small
        premium = env.quote(5 * ATTO, 300)
        env.advance(ACTIVATION + 300 * 12 + 1)
        env.contract.expire_policy(1)  # frees the lock
        env.transfers.clear()
        value = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        assert value == 100 * ATTO + premium
        assert env.withdraw(env.alice, value) == str(value)
        assert env.paid_to(env.alice) == value
        assert env.metrics()["tvl"] == "0"

    def test_partial_withdraw_burns_proportional_shares(self, env):
        env.deposit(env.alice, 100 * ATTO)
        env.withdraw(env.alice, 40 * ATTO)
        m = env.metrics()
        assert m["tvl"] == str(60 * ATTO)
        assert m["total_shares"] == str(60 * ATTO)

    def test_withdraw_more_than_position_reverts(self, env):
        env.deposit(env.alice, 10 * ATTO)
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.alice, 10 * ATTO + 1)

    def test_withdraw_without_position_reverts(self, env):
        env.deposit(env.alice, 10 * ATTO)
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.bob, 1)

    def test_withdraw_zero_reverts(self, env):
        env.deposit(env.alice, 10 * ATTO)
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.withdraw(env.alice, 0)

    def test_withdraw_cannot_touch_locked_coverage(self, funded):
        env = funded
        env.create(env.bob, coverage=10 * ATTO)
        free = int(env.metrics()["free_liquidity"])
        assert free == int(env.metrics()["tvl"]) - 10 * ATTO
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, free + 1)
        env.withdraw(env.owner, free)  # exactly the free portion is fine
        env.assert_solvent()
        assert int(env.metrics()["tvl"]) == 10 * ATTO  # only the locked cover remains

    def test_deposit_withdraw_roundtrip_never_gains(self, env):
        env.deposit(env.alice, 7 * ATTO + 12345)
        env.deposit(env.bob, 3 * ATTO + 999)
        env.transfers.clear()
        v = int(env.contract.get_underwriter(env.hex(env.bob))["value"])
        env.withdraw(env.bob, v)
        assert env.paid_to(env.bob) <= 3 * ATTO + 999


# ============================================================================
# Premium pricing
# ============================================================================
class TestPremium:
    @pytest.mark.parametrize("uptime,rate", [(9999, 800), (9990, 800), (9950, 400), (9900, 400), (9500, 200), (9000, 200)])
    def test_tier_rates_for_one_year(self, env, uptime, rate):
        cov = 10 * ATTO
        assert env.quote(cov, BLOCKS_PER_YEAR, uptime) == cov * rate // 10000

    def test_quote_matches_formula(self, env):
        for cov, blocks, up in [(5 * ATTO, 100_000, 9990), (3 * ATTO + 7, 12_345, 9900), (ATTO, 300, 9500)]:
            assert env.quote(cov, blocks, up) == premium_formula(cov, blocks, up)

    def test_premium_floor(self, env):
        assert env.quote(10**15, 300, 9500) == 10**15 * 10 // 10000

    def test_gold_costs_more_than_silver(self, env):
        assert env.quote(ATTO, 500_000, 9990) > env.quote(ATTO, 500_000, 9900) > env.quote(ATTO, 500_000, 9500)

    def test_underpayment_reverts(self, funded):
        env = funded
        with env.vm.expect_revert("[EXPECTED]"):
            env.create(env.bob, value=env.quote() - 1)

    def test_overpayment_is_refunded(self, funded):
        env = funded
        q = env.quote()
        env.transfers.clear()
        env.create(env.bob, value=q + 5 * ATTO)
        assert env.paid_to(env.bob) == 5 * ATTO
        assert env.policy(1)["premium"] == str(q)

    def test_premium_flows_to_pool_and_run_rate(self, funded):
        env = funded
        q = env.quote()
        env.create(env.bob)
        m = env.metrics()
        assert m["total_premiums"] == str(q)
        assert m["tvl"] == str(100 * ATTO + q)
        assert m["apy_bps"] > 0


# ============================================================================
# Authenticated infrastructure registry
# ============================================================================
class TestRegistry:
    def test_bootstrapped_listings_are_complete_and_committed(self, env):
        eps = env.contract.list_endpoints(0, 50)
        assert [e["endpoint_id"] for e in eps] == [p[0] for p in PROVIDERS]
        a = env.contract.get_endpoint(ALPHA)
        assert a["url"] == "https://rpc.node-alpha.io" and a["domain"] == "node-alpha.io"
        assert a["apex"] == "node-alpha.io" and a["chain_id"] == CHAIN_ID and a["status"] == "LISTED"
        want = hashlib.sha256(f"pulsesla/v1|{ALPHA}|Alpha Nodes|node-alpha.io|{CHAIN_ID}|https://rpc.node-alpha.io".encode()).hexdigest()
        assert a["attestation"] == want
        assert env.contract.compute_attestation(ALPHA, "Alpha Nodes", "node-alpha.io", CHAIN_ID, a["url"]) == want
        assert a["insurable_from"] == a["listed_at"] + LISTING_DELAY
        assert env.contract.get_governor() == env.hex(env.owner)
        assert env.metrics()["listed_endpoints"] == len(PROVIDERS)

    def test_reference_set_is_independent_and_bounded(self, env):
        refs = env.contract.get_references(ALPHA)
        assert refs == ["beta-rpc", "gamma-rpc", "delta-rpc", "epsilon-rpc"]  # four others, never itself
        assert env.contract.get_references("zeta-rpc") == ["alpha-rpc", "beta-rpc", "gamma-rpc", "delta-rpc"]

    def test_only_the_governor_can_list_or_delist(self, env):
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.register("omega-rpc", "Omega Nodes", "node-omega.io", who=env.bob)
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.vm.sender = env.bob
            env.contract.delist_endpoint(ALPHA)
        assert env.metrics()["listed_endpoints"] == len(PROVIDERS)

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"endpoint_id": "A"},  # too short / uppercase
            {"endpoint_id": "has space"},
            {"endpoint_id": "UPPER-CASE"},
            {"endpoint_id": ALPHA},  # duplicate id
            {"url": "https://rpc.node-alpha.io"},  # duplicate url
            {"url": "http://rpc.node-omega.io"},  # not https
            {"url": "https://10.0.0.5/rpc", "domain": "10.0.0.5"},  # private address
            {"url": "https://localhost:8545", "domain": "localhost"},
            {"url": "https://user:pw@rpc.node-omega.io"},
            {"url": "https://rpc.node-omega.io", "domain": "node-other.io"},  # host not under the declared domain
            {"domain": "rpc.node-omega.io"},  # not a registrable domain
            {"attestation": "0" * 64},  # commitment does not match
            {"attestation": "nothex"},
            {"chain_id": 0},
            {"provider": "x"},
            {"provider": "Bad|Name"},
        ],
    )
    def test_invalid_listings_are_rejected(self, env, kwargs):
        args = {"endpoint_id": "omega-rpc", "provider": "Omega Nodes", "domain": "node-omega.io"}
        args.update(kwargs)
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.register(**args)
        assert env.metrics()["listed_endpoints"] == len(PROVIDERS)

    def test_a_forged_commitment_is_rejected_but_the_real_one_lists(self, env):
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.register("omega-rpc", "Omega Nodes", "node-omega.io", attestation=attest("omega-rpc", "Other", "node-omega.io", 1, "https://rpc.node-omega.io"))
        assert env.register("omega-rpc", "Omega Nodes", "node-omega.io") == "omega-rpc"

    def test_endpoint_must_authenticate_as_the_declared_chain(self, env):
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.register("omega-rpc", "Omega Nodes", "node-omega.io", mock_chain=5)  # serves chain 5, declared 1
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.register("omega-rpc", "Omega Nodes", "node-omega.io", chain_id=137)  # serves chain 1, declared 137

    def test_unreachable_or_garbage_endpoints_cannot_be_listed(self, env):
        env.vm.clear_mocks()
        env.vm.strict_mocks = True
        env.vm.sender, env.vm.value = env.owner, 0
        att = attest("omega-rpc", "Omega Nodes", "node-omega.io", 1, "https://rpc.node-omega.io")
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.contract.register_endpoint("omega-rpc", "Omega Nodes", "node-omega.io", 1, "https://rpc.node-omega.io", att)
        env.vm.strict_mocks = False
        env.mock_chain_id(body="<html>not json rpc</html>")
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.contract.register_endpoint("omega-rpc", "Omega Nodes", "node-omega.io", 1, "https://rpc.node-omega.io", att)

    def test_subdomain_listing_under_the_declared_domain_is_accepted(self, env):
        env.register("sub-node", "Sub Node", "node-sub.io", url="https://eth.mainnet.node-sub.io/v1")
        e = env.contract.get_endpoint("sub-node")
        assert e["host"] == "eth.mainnet.node-sub.io" and e["apex"] == "node-sub.io"

    def test_registry_capacity_is_bounded(self, env):
        for i in range(len(PROVIDERS), 32):
            env.register(f"p{i:02d}", f"Provider {i}", f"node-p{i:02d}.io")
        assert env.metrics()["listed_endpoints"] == 32
        with env.vm.expect_revert("[REGISTRY_REJECTED]"):
            env.register("overflow", "Overflow", "node-overflow.io")

    def test_new_listing_is_not_insurable_until_the_listing_delay_elapses(self, funded):
        env = funded
        env.register("omega-rpc", "Omega Nodes", "node-omega.io")
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint="omega-rpc")
        env.advance(LISTING_DELAY - 5)
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint="omega-rpc")
        env.advance(10)
        assert env.policy(env.create(env.bob, endpoint="omega-rpc"))["endpoint_id"] == "omega-rpc"

    def test_new_listing_is_not_a_reference_until_it_has_aged(self, bare):
        """A just-listed (possibly hostile) endpoint must not be able to sway a round."""
        env = bare
        for endpoint_id, provider, domain in PROVIDERS[:4]:
            env.register(endpoint_id, provider, domain)
        env.advance(LISTING_DELAY + 1)
        assert env.contract.get_references(ALPHA) == ["beta-rpc", "gamma-rpc", "delta-rpc"]
        env.register("epsilon-rpc", "Epsilon Nodes", "node-epsilon.io")
        assert env.contract.get_references(ALPHA) == ["beta-rpc", "gamma-rpc", "delta-rpc"]  # fresh: excluded
        env.advance(LISTING_DELAY - 5)
        assert "epsilon-rpc" not in env.contract.get_references(ALPHA)
        env.advance(10)
        assert env.contract.get_references(ALPHA) == ["beta-rpc", "gamma-rpc", "delta-rpc", "epsilon-rpc"]

    def test_delisting_blocks_new_policies_but_existing_ones_keep_running(self, funded):
        env = funded
        env.target = "beta-rpc"
        pid = env.create(env.bob, endpoint="beta-rpc")
        env.vm.sender = env.owner
        assert env.contract.delist_endpoint("beta-rpc") == "DELISTED"
        assert env.contract.get_endpoint("beta-rpc")["status"] == "DELISTED"
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.alice, endpoint="beta-rpc")
        assert "beta-rpc" not in env.contract.get_references(ALPHA)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]  # the snapshot of the immutable listing is still probed
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.vm.sender = env.owner
            env.contract.delist_endpoint("beta-rpc")

    def test_registry_needs_three_independent_reference_providers(self, bare):
        env = bare
        for endpoint_id, provider, domain in PROVIDERS[:3]:
            env.register(endpoint_id, provider, domain)
        env.advance(LISTING_DELAY + 1)
        env.deposit(env.owner, 100 * ATTO)
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):  # alpha has only two references
            env.create(env.bob)
        env.register("delta-rpc", "Delta Nodes", "node-delta.io")
        env.advance(LISTING_DELAY + 1)
        assert env.policy(env.create(env.bob))["status"] == "ACTIVE"

    def test_a_provider_cannot_corroborate_itself(self, bare):
        """Listings that share a registrable domain are one provider: they never reference each other."""
        env = bare
        env.register("shared-a", "Shared A", "node-shared.io", url="https://a.node-shared.io")
        env.register("shared-b", "Shared B", "node-shared.io", url="https://b.node-shared.io")
        for endpoint_id, provider, domain in PROVIDERS[:3]:
            env.register(endpoint_id, provider, domain)
        env.advance(LISTING_DELAY + 1)
        assert "shared-b" not in env.contract.get_references("shared-a")
        assert env.contract.get_references("shared-a") == ["alpha-rpc", "beta-rpc", "gamma-rpc"]

    def test_governor_transfer_hands_over_listing_power(self, env):
        env.vm.sender = env.owner
        env.contract.transfer_governor(env.hex(env.bob))
        assert env.contract.get_governor() == env.hex(env.bob)
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.register("omega-rpc", "Omega Nodes", "node-omega.io", who=env.owner)
        assert env.register("omega-rpc", "Omega Nodes", "node-omega.io", who=env.bob) == "omega-rpc"


# ============================================================================
# Policy creation: validation and exposure caps
# ============================================================================
UNAUTHENTICATED = [
    "https://rpc.attacker-owned.io",  # a holder-controlled URL
    "https://rpc.node-alpha.io",  # even a listed provider's URL is not a handle: only ids are
    "rpc.node-alpha.io",
    "http://localhost:8545",
    "http://127.0.0.1:8545",
    "https://user:pw@rpc.example.com",
    "evil-rpc",
    "ALPHA-RPC",
    "alpha-rpc ",
    "",
]


class TestCreatePolicy:
    @pytest.mark.parametrize("endpoint", UNAUTHENTICATED)
    def test_unauthenticated_endpoints_cannot_be_insured(self, funded, endpoint):
        env = funded
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint=endpoint, value=ATTO)
        m = env.metrics()
        assert env.contract.get_policy_count() == 0 and m["locked_coverage"] == "0" and m["total_premiums"] == "0"

    def test_the_legacy_url_signature_is_gone(self, funded):
        env = funded
        env.fund(env.bob)
        env.vm.sender, env.vm.value = env.bob, ATTO
        with pytest.raises(Exception):
            env.contract.create_policy("https://rpc.attacker-owned.io", 500, 5 * ATTO, 100_000, 9990, 5, "rpc")
        assert env.contract.get_policy_count() == 0

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"coverage": 10**15 - 1},
            {"blocks": 299},
            {"blocks": 2_628_001},
            {"uptime": 8999},
            {"uptime": 10000},
            {"interval": 4},
            {"interval": 7201},
        ],
    )
    def test_parameter_bounds(self, funded, kwargs):
        env = funded
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.create(env.bob, value=ATTO, **kwargs)

    def test_policy_record_snapshots_the_registry_listing(self, funded):
        env = funded
        created = env.now
        pid = env.create(env.bob, endpoint="gamma-rpc", coverage=4 * ATTO, blocks=1000, uptime=9900, interval=10)
        p = env.policy(pid)
        assert pid == 1 and env.contract.get_policy_count() == 1
        assert p["holder"].lower() == env.hex(env.bob)
        assert (p["endpoint_id"], p["endpoint_url"], p["host"], p["chain_id"]) == ("gamma-rpc", "https://rpc.node-gamma.io", "rpc.node-gamma.io", CHAIN_ID)
        assert p["coverage"] == str(4 * ATTO) and p["min_uptime_bps"] == 9900
        assert p["probe_interval"] == 120
        assert p["active_from"] == created + ACTIVATION
        assert p["expires_at"] == created + ACTIVATION + 1000 * 12
        assert env.metrics()["locked_coverage"] == str(4 * ATTO)

    def test_the_registry_governor_cannot_hold_a_policy(self, funded):
        env = funded
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.create(env.owner)

    def test_empty_pool_cannot_write_policies(self, env):
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(env.bob, value=ATTO)

    def test_per_policy_cap(self, funded):
        env = funded
        env.create(env.bob, coverage=10 * ATTO)  # exactly 10% of 100 GEN
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(env.alice, endpoint="beta-rpc", coverage=11 * ATTO)

    def test_per_provider_cap(self, funded):
        env = funded
        a, b, c = env.distinct_holders(3)
        env.create(a, coverage=10 * ATTO)
        env.create(b, coverage=10 * ATTO)  # provider now at 20%
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, coverage=ATTO)
        env.create(c, endpoint="beta-rpc", coverage=ATTO)  # other provider is fine

    def test_per_holder_cap(self, funded):
        env = funded
        a = env.distinct_holders(1)[0]
        env.create(a, endpoint="alpha-rpc", coverage=10 * ATTO)
        env.create(a, endpoint="beta-rpc", coverage=10 * ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(a, endpoint="gamma-rpc", coverage=ATTO)

    def test_utilization_cap(self, funded):
        env = funded
        holders = env.distinct_holders(4)
        ids = [p[0] for p in PROVIDERS]
        for i in range(8):  # 8 x 10 GEN = the 80% utilization ceiling
            env.create(holders[i // 2], endpoint=ids[i // 2], coverage=10 * ATTO)
        assert int(env.metrics()["utilization_bps"]) <= 8000
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(env.alice, endpoint=ids[4], coverage=5 * ATTO)
        env.assert_solvent()


# ============================================================================
# Policy expiration
# ============================================================================
class TestExpiry:
    def test_cannot_expire_early(self, funded):
        env = funded
        pid = env.create(env.bob, blocks=300)
        env.advance(ACTIVATION + 300 * 12 - 5)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.contract.expire_policy(pid)

    def test_expiry_releases_cover_and_exposure(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO, blocks=300)
        env.advance(ACTIVATION + 300 * 12)
        assert env.contract.expire_policy(pid) == "EXPIRED"  # permissionless
        assert env.policy(pid)["status"] == "EXPIRED"
        m = env.metrics()
        assert m["locked_coverage"] == "0" and m["active_policies"] == 0 and m["apy_bps"] == 0
        # provider / holder caps are free again
        env.create(env.bob, coverage=10 * ATTO)
        env.create(env.bob, coverage=10 * ATTO)

    def test_expired_policy_cannot_be_probed(self, funded):
        env = funded
        pid = env.create(env.bob, blocks=300)
        env.advance(ACTIVATION + 300 * 12 + 1)
        env.healthy()
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.probe(pid)

    def test_expire_twice_reverts(self, funded):
        env = funded
        pid = env.create(env.bob, blocks=300)
        env.advance(ACTIVATION + 300 * 12 + 1)
        env.contract.expire_policy(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.contract.expire_policy(pid)

    def test_unknown_policy_reverts(self, funded):
        with funded.vm.expect_revert("[INVALID_STATE]"):
            funded.policy(99)


# ============================================================================
# Corroborated probes under mocked web consensus
# ============================================================================
class TestProbes:
    @pytest.fixture
    def pol(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        return env, pid

    def test_healthy_response_is_corroborated_by_every_reference(self, pol):
        env, pid = pol
        env.healthy()
        tvl = int(env.metrics()["tvl"])
        r = env.probe(pid)
        assert r["ok"] and r["verdict"] == "HEALTHY" and r["reason"] == "OK" and r["status"] == 200
        assert r["refs_ok"] == r["refs_total"] == 4 and r["block"] == r["ref_head"] == env.head
        p = env.policy(pid)
        assert p["baseline_ok"] and p["samples_ok"] == 1 and p["last_block"] == env.head and p["uptime_bps"] == 10000
        # a round that finds nothing wrong forfeits the spam bond to underwriters
        assert int(env.metrics()["tvl"]) == tvl + PROBE_BOND
        assert env.paid_to(env.charlie) == 0

    @pytest.mark.parametrize("status", [500, 502, 503, 504, 404])
    def test_http_error_statuses_fail_when_the_network_is_healthy(self, pol, status):
        env, pid = pol
        env.fail(("status", status))
        tvl = int(env.metrics()["tvl"])
        r = env.probe(pid)
        assert not r["ok"] and r["verdict"] == "FAILING" and r["reason"] == "HTTP_ERROR" and r["status"] == status
        assert r["refs_ok"] == 4
        assert env.policy(pid)["consecutive_failures"] == 1
        # useful probe: bond refunded in full, pool unchanged
        assert env.paid_to(env.charlie) == PROBE_BOND
        assert int(env.metrics()["tvl"]) == tvl

    def test_unreachable_target_fails_when_the_network_is_healthy(self, pol):
        env, pid = pol
        env.fail("down")
        r = env.probe(pid)
        assert r["verdict"] == "FAILING" and r["reason"] == "UNREACHABLE" and r["status"] == 0

    def test_rate_limiting_is_inconclusive_not_an_outage(self, pol):
        env, pid = pol
        env.fail(("status", 429))
        r = env.probe(pid)
        assert r["verdict"] == "INCONCLUSIVE" and r["reason"] == "RATE_LIMITED" and not r["ok"]
        p = env.policy(pid)
        assert p["consecutive_failures"] == 0 and p["downtime_secs"] == 0 and p["inconclusive_rounds"] == 1
        assert env.paid_to(env.charlie) == PROBE_BOND  # bond returned in full

    def test_staleness_is_measured_against_the_reference_head(self, pol):
        env, pid = pol
        env.fail(("lag", 50))  # exactly at the tolerance
        assert env.probe(pid)["verdict"] == "HEALTHY"
        env.advance(301)
        env.fail(("lag", 51))
        r = env.probe(pid)
        assert r["verdict"] == "FAILING" and r["reason"] == "STALE_BLOCK"
        env.advance(301)
        env.fail(env.head + 1_000)  # ahead of the pack is never "stale"
        assert env.probe(pid)["verdict"] == "HEALTHY"

    @pytest.mark.parametrize(
        "body",
        ['{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}', "not json", "{}", '{"result":"abc"}',
         '{"result":"0x"}', '{"result":"0x0"}', "[]"],
    )
    def test_invalid_payload_fails(self, pol, body):
        env, pid = pol
        env.fail(("body", body))
        r = env.probe(pid)
        assert r["verdict"] == "FAILING" and r["reason"] == "BAD_PAYLOAD"

    def test_observer_side_outage_is_inconclusive_not_a_provider_failure(self, pol):
        env, pid = pol
        env.blind()  # nothing answers: the observers, not the provider, are cut off
        r = env.probe(pid)
        assert r["verdict"] == "INCONCLUSIVE" and r["reason"] == "NO_BASELINE" and r["refs_ok"] == 0
        for _ in range(20):
            assert env.next_probe(pid)["verdict"] == "INCONCLUSIVE"
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and p["consecutive_failures"] == 0 and p["downtime_secs"] == 0
        assert p["inconclusive_rounds"] == 21 and not p["baseline_ok"]

    def test_one_reference_down_still_corroborates_two_down_does_not(self, pol):
        env, pid = pol
        env.mock(target=("status", 502), refs="head", beta_rpc="down")
        r = env.probe(pid)
        assert r["verdict"] == "FAILING" and r["refs_ok"] == 3 and r["refs_total"] == 4
        env.advance(301)
        env.mock(target=("status", 502), refs="head", beta_rpc="down", gamma_rpc="down")
        r = env.probe(pid)
        assert r["verdict"] == "INCONCLUSIVE" and r["refs_ok"] == 2

    def test_a_single_outlier_reference_cannot_move_the_reference_head(self, pol):
        env, pid = pol
        env.mock("head", "head", beta_rpc=env.head + 10_000)  # one reference claims a huge height
        r = env.probe(pid)
        assert r["verdict"] == "HEALTHY" and r["ref_head"] == env.head
        env.advance(301)
        env.mock("head", "head", beta_rpc=1)  # one reference is absurdly low
        r = env.probe(pid)
        assert r["verdict"] == "HEALTHY" and r["ref_head"] == env.head

    def test_probe_interval_enforced(self, pol):
        env, pid = pol
        env.healthy()
        env.probe(pid)
        env.advance(150)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)
        env.advance(151)
        assert env.probe(pid)["ok"]

    def test_activation_delay_blocks_early_probes(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.advance(ACTIVATION - 10)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)

    def test_probe_bond_required(self, pol):
        env, pid = pol
        with env.vm.expect_revert("[EXPECTED]"):
            env.probe(pid, bond=PROBE_BOND - 1)

    def test_excess_bond_is_refunded(self, pol):
        env, pid = pol
        env.probe(pid, bond=PROBE_BOND * 4)
        assert env.paid_to(env.charlie) == PROBE_BOND * 3

    def test_anyone_may_probe(self, pol):
        env, pid = pol
        assert env.probe(pid, who=env.alice)["ok"]

    def test_incident_log_records_the_corroboration(self, pol):
        env, pid = pol
        env.fail(("status", 502))
        env.probe(pid)
        n = env.contract.get_incident_count()
        recs = [json.loads(s) for s in env.contract.get_incidents(0, 50)]
        assert n == len(recs)
        kinds = [r["kind"] for r in recs]
        assert kinds.count("ENDPOINT_LISTED") == len(PROVIDERS) and kinds[-2] == "POLICY_CREATED"
        last = recs[-1]
        assert last["kind"] == "PROBE" and last["status"] == 502 and last["ok"] is False and last["verdict"] == "FAILING"
        assert last["refs_ok"] == last["refs_total"] == 4 and last["ref_head"] > 0
        assert "502" in last["detail"] and last["by"].lower() == env.hex(env.charlie)


# ============================================================================
# Validator rules (the real validator closure, re-run by the harness)
# ============================================================================
class TestValidatorConsensus:
    @pytest.fixture
    def led(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        return env, pid

    def test_validator_agrees_when_it_independently_observes_the_same_verdict(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        assert env.vm.run_validator()

    def test_validator_agrees_on_failure_even_with_a_different_failure_class(self, led):
        env, pid = led
        env.fail(("status", 502))
        env.probe(pid)
        env.fail(("status", 504))
        assert env.vm.run_validator()
        env.fail("down")
        assert env.vm.run_validator()

    def test_validator_rejects_a_leader_that_reports_failure_for_a_healthy_node(self, led):
        env, pid = led
        env.fail(("status", 502))
        env.probe(pid)
        env.healthy()  # validator sees a healthy endpoint
        assert not env.vm.run_validator()

    def test_validator_rejects_a_leader_that_reports_healthy_for_a_dead_node(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        env.fail(("status", 502))
        assert not env.vm.run_validator()

    def test_validator_rejects_a_failure_it_cannot_corroborate_against_references(self, led):
        """The leader saw a corroborated failure, but this validator's references are dark."""
        env, pid = led
        env.fail(("status", 502))
        env.probe(pid)
        env.blind()
        assert not env.vm.run_validator()

    def test_validators_agree_that_a_blind_round_is_inconclusive(self, led):
        env, pid = led
        env.blind()
        assert env.probe(pid)["verdict"] == "INCONCLUSIVE"
        assert env.vm.run_validator()
        env.healthy()  # a validator that CAN see the network refuses to call it inconclusive
        assert not env.vm.run_validator()

    def test_validator_rejects_leader_error(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        assert not env.vm.run_validator(leader_error=Exception("[LLM_ERROR] boom"))

    def test_validator_rejects_malformed_leader_result(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        assert not env.vm.run_validator(leader_result={"verdict": "HEALTHY"})
        assert not env.vm.run_validator(leader_result="healthy")

    def test_validator_accepts_an_honest_leader_result(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        assert env.vm.run_validator(leader_result=leader_round(env, env.head))

    def test_validator_rejects_self_contradicting_and_forged_results(self, led):
        env, pid = led
        env.healthy()
        env.probe(pid)
        h = env.head
        ok = leader_round(env, h)
        assert env.vm.run_validator(leader_result=ok)
        # healthy claim with a non-200 status
        assert not env.vm.run_validator(leader_result={**ok, "status": 502})
        # a FAILING verdict that its own observations do not support
        assert not env.vm.run_validator(leader_result={**ok, "verdict": "FAILING", "reason": "HTTP_ERROR"})
        # an inflated reference head that the leader's own references contradict
        assert not env.vm.run_validator(leader_result={**ok, "ref_head": h + 1_000})
        # a dropped reference, a swapped reference id, and a miscounted total
        assert not env.vm.run_validator(leader_result={**ok, "refs": ok["refs"][:-1], "refs_total": 3})
        swapped = [dict(r) for r in ok["refs"]]
        swapped[0]["id"] = "attacker-rpc"
        assert not env.vm.run_validator(leader_result={**ok, "refs": swapped})
        # t_ok disagreeing with t_reason
        assert not env.vm.run_validator(leader_result={**ok, "t_reason": "HTTP_ERROR"})

    def test_a_leader_cannot_hide_unhealthy_references_to_manufacture_a_failure(self, led):
        """Claim the references are healthy at a fabricated height to call a healthy target stale."""
        env, pid = led
        env.healthy()
        env.probe(pid)
        h = env.head
        forged = leader_round(env, h, ref_blocks=[h + 5_000] * 4)  # target "50+ behind" a fake head
        assert forged["verdict"] == "FAILING" and forged["reason"] == "STALE_BLOCK"
        assert not env.vm.run_validator(leader_result=forged)

    def test_failing_leader_result_is_accepted_when_the_validator_sees_the_same_outage(self, led):
        env, pid = led
        env.fail(("status", 502))
        env.probe(pid)
        assert env.vm.run_validator(leader_result=failing_leader_round(env, env.head))


# ============================================================================
# Staged claims: breach -> grace -> re-verification -> vesting -> release
# ============================================================================
class TestClaims:
    def test_four_consecutive_corroborated_rounds_over_fifteen_minutes_stage_a_claim(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        rounds = [env.next_probe(pid) for _ in range(3)]
        assert not any(r["breach_staged"] for r in rounds)  # three rounds span only ~10 minutes
        assert env.policy(pid)["status"] == "ACTIVE"
        r4 = env.next_probe(pid)
        assert r4["breach_staged"]
        p = env.policy(pid)
        assert p["status"] == "BREACH_PENDING" and p["claim_count"] == 1
        assert p["settle_at"] == env.now + GRACE
        assert p["outage_blocks"] >= 25 and env.now - p["outage_started_at"] >= 15 * 60
        m = env.metrics()
        assert m["reserved_payouts"] == str(5 * ATTO) and m["total_breaches"] == 1 and m["staged_claims"] == str(5 * ATTO)
        env.assert_solvent()

    def test_fast_probing_cannot_shortcut_the_minimum_outage_duration(self, funded):
        """One-minute cadence: sixteen failing rounds are needed to span fifteen minutes."""
        env = funded
        pid = env.create(env.bob, interval=5)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        staged_at = None
        for n in range(1, 25):
            if env.next_probe(pid)["breach_staged"]:
                staged_at = n
                break
        assert staged_at == 16

    def test_the_outage_must_span_real_reference_chain_progress(self, funded):
        """Time alone is not enough: if the reference chain itself is not advancing, nothing stages."""
        env = funded
        pid = env.create(env.bob)
        env.activate()
        frozen = env.head
        env.mock(target=frozen, refs=frozen)
        assert env.probe(pid)["ok"]
        env.mock_many({ALPHA: ("status", 502)}, default=frozen)  # references stuck at the same height
        for _ in range(8):
            r = env.next_probe(pid)
            assert r["verdict"] == "FAILING" and not r["breach_staged"]
        assert env.policy(pid)["outage_blocks"] == 0
        env.mock_many({ALPHA: ("status", 502)}, default="head")  # the chain moves again
        assert env.next_probe(pid)["breach_staged"]

    def test_recovery_resets_the_failure_streak(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        env.next_probe(pid)
        env.next_probe(pid)
        env.healthy()
        env.next_probe(pid)
        p = env.policy(pid)
        assert p["consecutive_failures"] == 0 and p["outage_started_at"] == 0
        env.fail()
        for _ in range(3):
            env.next_probe(pid)
        assert env.policy(pid)["status"] == "ACTIVE"

    def test_gold_breaches_where_bronze_tolerates_the_same_outage(self, funded):
        env = funded
        gold = env.create(env.bob, uptime=9990)
        bronze = env.create(env.alice, uptime=9000)
        env.activate()
        env.healthy()
        env.probe(gold)
        env.probe(bronze)
        env.fail()
        for _ in range(4):
            env.advance(301)
            env.probe(gold)
            env.probe(bronze)
        assert env.policy(gold)["status"] == "BREACH_PENDING"  # ~98.6% < 99.9%
        assert env.policy(bronze)["status"] == "ACTIVE"  # ~98.6% >= 90.0%
        assert env.policy(bronze)["uptime_bps"] == env.policy(gold)["uptime_bps"]

    def test_settle_before_grace_reverts(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE - 5)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.settle(pid)

    def test_settle_requires_a_staged_claim(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(42)

    def test_confirmed_breach_starts_a_vesting_payout_and_pays_nothing_immediately(self, funded):
        env = funded
        cov = 5 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        tvl_before = int(env.metrics()["tvl"])
        env.transfers.clear()
        r = env.settle(pid)
        p = env.policy(pid)
        expected = vested(cov, p["breach_at"] - p["active_from"])  # frozen at staging, not at settlement
        assert r["confirmed"] and r["payout"] == str(expected)
        assert r["releasable_from"] == env.now + COOLDOWN and r["fully_vested_at"] == env.now + COOLDOWN + VEST
        assert cov * 25 // 100 <= expected < cov * 30 // 100  # young policy: ~25% vested
        assert p["status"] == "VESTING" and p["payout"] == str(expected) and p["released"] == "0" and p["releasable"] == "0"
        assert env.paid_to(env.bob) == 0  # the holder receives nothing at confirmation
        assert env.paid_to(env.charlie) == PROBE_BOND  # settler's bond returned
        m = env.metrics()
        assert int(m["tvl"]) == tvl_before  # nothing has left the pool yet
        assert m["owed_payouts"] == m["reserved_payouts"] == m["locked_coverage"] == str(expected)
        assert m["staged_claims"] == "0" and m["active_policies"] == 0 and m["total_payouts"] == "0"
        assert int(m["free_liquidity"]) == tvl_before - expected  # the unpaid slice of cover is free again
        env.assert_solvent()

    def test_payout_streams_after_a_cooldown_and_goes_to_the_holder(self, funded):
        env = funded
        cov = 5 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        payout = int(env.settle(pid)["payout"])
        env.transfers.clear()

        env.advance(COOLDOWN - 10)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.release(pid)  # still cooling down
        env.advance(10 + VEST // 3)
        r = env.release(pid, who=env.alice)  # a stranger triggers; the HOLDER is paid
        assert r["released"] == str(payout // 3) and not r["done"]
        assert env.paid_to(env.bob) == payout // 3 and env.paid_to(env.alice) == 0
        assert env.policy(pid)["status"] == "VESTING"
        env.assert_solvent()
        with env.vm.expect_revert("[TOO_SOON]"):
            env.release(pid)  # nothing new has vested

        env.advance(VEST // 3)
        r = env.release(pid)
        assert int(r["total_released"]) == payout * 2 * (VEST // 3) // VEST
        env.advance(VEST)
        r = env.release(pid)
        assert r["done"] and r["total_released"] == str(payout)
        assert env.paid_to(env.bob) == payout
        p = env.policy(pid)
        assert p["status"] == "PAID" and p["released"] == str(payout)
        m = env.metrics()
        assert m["owed_payouts"] == m["reserved_payouts"] == m["locked_coverage"] == "0"
        assert m["total_payouts"] == str(payout)
        assert int(m["tvl"]) == 100 * ATTO + int(m["total_premiums"]) + int(m["total_bond_forfeits"]) - payout
        env.assert_solvent()
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.release(pid)

    def test_aged_policy_pays_full_coverage_after_vesting(self, funded):
        env = funded
        cov = 5 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.activate()
        env.advance(8 * 86400)
        env.healthy()
        env.probe(pid)
        env.fail(("status", 504))
        for _ in range(4):
            env.next_probe(pid)
        env.advance(GRACE + 1)
        assert env.settle(pid)["payout"] == str(cov)
        env.advance(COOLDOWN + VEST)
        assert env.release(pid)["done"]
        assert env.paid_to(env.bob) == cov

    def test_settled_claim_cannot_be_settled_again(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.settle(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        assert env.paid_to(env.bob) == 0

    def test_recovered_endpoint_dismisses_the_claim(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.healthy()  # node came back during the grace period
        tvl = int(env.metrics()["tvl"])
        env.transfers.clear()
        r = env.settle(pid)
        assert not r["confirmed"]
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and p["consecutive_failures"] == 0 and p["outage_started_at"] == 0
        m = env.metrics()
        assert m["reserved_payouts"] == "0" and m["locked_coverage"] == str(5 * ATTO)
        assert int(m["tvl"]) == tvl + PROBE_BOND  # unproductive settle bond forfeited
        assert env.paid_to(env.bob) == 0
        env.assert_solvent()

    def test_an_uncorroborated_reverification_changes_nothing(self, funded):
        """If the references are dark at settlement the claim neither pays nor dismisses."""
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.blind()
        before = env.metrics()
        with env.vm.expect_revert("[INCONCLUSIVE]"):
            env.settle(pid)
        assert env.policy(pid)["status"] == "BREACH_PENDING"
        assert env.metrics()["reserved_payouts"] == before["reserved_payouts"]
        env.fail()  # references back: the fresh corroborated round now confirms
        assert env.settle(pid)["confirmed"]

    def test_settle_bond_required(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        with env.vm.expect_revert("[EXPECTED]"):
            env.settle(pid, bond=1)

    def test_unsettled_claim_lapses_and_releases_liquidity(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO)
        env.stage_breach(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.contract.expire_policy(pid)  # still inside the window
        env.advance(GRACE + 14 * 86400 + 1)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        assert env.contract.expire_policy(pid) == "LAPSED"
        m = env.metrics()
        assert m["locked_coverage"] == "0" and m["reserved_payouts"] == "0"
        env.assert_solvent()

    def test_claim_can_be_restaged_after_dismissal(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.healthy()
        env.settle(pid)  # dismissed
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        p = env.policy(pid)
        assert p["status"] == "BREACH_PENDING" and p["claim_count"] == 2

    def test_underwriters_cannot_exit_behind_a_pending_claim(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        tvl = int(env.metrics()["tvl"])
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, tvl)
        # the sole underwriter may not burn every share behind outstanding cover
        # (see TestAuditRegressions); a sliver of the position must remain
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, tvl - 10 * ATTO)
        env.withdraw(env.owner, tvl - 10 * ATTO - 2 * 10**12)  # the reserved 10 stays

    def test_vesting_payout_capital_cannot_be_withdrawn(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        payout = int(env.settle(pid)["payout"])
        free = int(env.metrics()["free_liquidity"])
        assert int(env.metrics()["tvl"]) - free == payout
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, free + 1)


# ============================================================================
# Moral hazard: the policyholder-controls-the-service self-attack
# ============================================================================
class TestMoralHazard:
    """The steward's rejection: a holder insures an endpoint they control, picks
    the observations that establish a breach, and collects without independent
    proof. Every vector is tested here."""

    # --- 1. bind coverage to authenticated infrastructure -------------------
    def test_an_attempt_to_insure_an_unauthenticated_arbitrary_endpoint_fails(self, funded):
        env = funded
        attacker_node = "https://rpc.attacker-owned.io"
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint=attacker_node, value=ATTO)
        assert env.contract.get_policy_count() == 0
        assert env.metrics()["locked_coverage"] == "0" and env.metrics()["total_premiums"] == "0"

    def test_a_holder_cannot_add_their_own_endpoint_to_the_registry(self, funded):
        env = funded
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.register("my-node", "My Node", "node-mine.io", who=env.bob)
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint="my-node")

    def test_a_freshly_listed_endpoint_cannot_be_insured_immediately_even_by_the_governors_choice(self, funded):
        """A compromised governor still cannot list-and-insure in one step: LPs get a full day to exit."""
        env = funded
        env.register("evil-rpc", "Evil Nodes", "node-evil.io")
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint="evil-rpc")
        env.advance(LISTING_DELAY - 60)
        with env.vm.expect_revert("[UNAUTHENTICATED_ENDPOINT]"):
            env.create(env.bob, endpoint="evil-rpc")
        # during that window an LP can leave with all free capital
        env.withdraw(env.owner, int(env.contract.get_underwriter(env.hex(env.owner))["withdrawable"]))

    def test_the_governor_cannot_collect_on_infrastructure_it_lists(self, funded):
        env = funded
        env.register("evil-rpc", "Evil Nodes", "node-evil.io")
        env.advance(LISTING_DELAY + 1)
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.create(env.owner, endpoint="evil-rpc")

    # --- 2. no selective / uncorroborated breach observations ---------------
    def test_a_single_uncorroborated_report_cannot_trigger_an_insurance_payout(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]
        # (a) one failing round -- even a fully corroborated one -- stages nothing
        env.fail()
        r = env.next_probe(pid)
        assert r["verdict"] == "FAILING" and not r["breach_staged"]
        # (b) a forged leader result claiming an outage is refused by a validator that sees a healthy network
        env.healthy()
        assert not env.vm.run_validator(leader_result=failing_leader_round(env, env.head))
        # (c) there is no staged claim to settle, so no payout path exists
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.release(pid)
        m = env.metrics()
        assert env.policy(pid)["status"] == "ACTIVE"
        assert m["total_payouts"] == "0" and m["owed_payouts"] == "0" and m["reserved_payouts"] == "0"
        assert env.paid_to(env.bob) == 0

    def test_a_localized_observation_without_reference_corroboration_is_discarded(self, funded):
        """The insured endpoint "fails" only from the observer's vantage: the references cannot be reached either."""
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.blind()
        for _ in range(30):
            r = env.next_probe(pid)
            assert r["verdict"] == "INCONCLUSIVE" and not r["breach_staged"]
        env.mock(target=("status", 502), refs="head", beta_rpc="down", gamma_rpc="down")  # references split
        for _ in range(10):
            assert env.next_probe(pid)["verdict"] == "INCONCLUSIVE"
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and p["consecutive_failures"] == 0 and p["claim_count"] == 0
        assert env.metrics()["total_breaches"] == 0

    def test_authentic_outage_detected_across_corroborated_validator_telemetry_pays(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.activate()
        env.advance(8 * 86400)  # fully aged policy: vesting ramp complete
        env.healthy()
        assert env.probe(pid)["ok"]

        # A real provider outage: the target is dead while every reference keeps advancing.
        env.fail(("status", 503))
        rounds = [env.next_probe(pid) for _ in range(4)]
        assert [r["verdict"] for r in rounds] == ["FAILING"] * 4
        assert all(r["refs_ok"] == r["refs_total"] == 4 for r in rounds)
        assert rounds[-1]["breach_staged"] and env.policy(pid)["status"] == "BREACH_PENDING"
        # every validator independently reaches the same verdict
        assert env.vm.run_validator()

        # grace period, then a fresh corroborated round confirms
        env.advance(GRACE + 1)
        r = env.settle(pid)
        assert r["confirmed"] and r["payout"] == str(cov)
        assert env.paid_to(env.bob) == 0  # vested, not instant

        # cooldown, then the payout streams to the holder
        env.advance(COOLDOWN + VEST)
        assert env.release(pid)["done"]
        assert env.paid_to(env.bob) == cov
        env.assert_solvent()
        recs = [json.loads(s) for s in env.contract.get_incidents(0, 100)]
        kinds = [x["kind"] for x in recs]
        assert "BREACH_STAGED" in kinds and "BREACH_CONFIRMED_VESTING" in kinds and kinds[-1] == "PAYOUT_RELEASED"
        confirmed = next(x for x in recs if x["kind"] == "BREACH_CONFIRMED_VESTING")
        assert confirmed["verdict"] == "FAILING" and confirmed["refs_ok"] == 4

    def test_a_provider_outage_correlated_with_the_references_is_not_paid(self, funded):
        """When most references fail with the target, the failure cannot be attributed to the insured provider."""
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.mock_many({ALPHA: "down", "beta-rpc": "down", "gamma-rpc": "down"}, default="head")
        for _ in range(8):
            assert not env.next_probe(pid)["breach_staged"]
        assert env.policy(pid)["status"] == "ACTIVE"

    def test_rate_limit_flooding_cannot_manufacture_a_breach(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail(("status", 429))
        for _ in range(12):
            r = env.next_probe(pid)
            assert r["verdict"] == "INCONCLUSIVE" and not r["breach_staged"]
        assert env.policy(pid)["downtime_secs"] == 0

    def test_a_brief_blip_chosen_by_the_holder_is_not_a_breach(self, funded):
        """Probing only while the endpoint blips: two failing rounds, then recovery."""
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        env.next_probe(pid)
        env.next_probe(pid)
        env.healthy()
        env.next_probe(pid)
        assert env.policy(pid)["consecutive_failures"] == 0
        assert env.metrics()["total_breaches"] == 0

    # --- 3. representative metrics: the holder cannot choose the denominator -
    def test_uptime_is_judged_on_a_floored_window_not_on_the_holders_samples(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        p = env.policy(pid)
        assert p["downtime_secs"] == 4 * 300
        # one hour old, yet judged against the 24 h floor: 1200 s / 86400 s, not 1200 s / 3600 s
        assert p["uptime_bps"] == 10000 - 1200 * 10000 // 86400

    def test_unprobed_healthy_history_dilutes_a_short_outage(self, funded):
        """A twenty-minute outage in a twenty-day-old window is 99.93% uptime: not a Gold breach."""
        env = funded
        pid = env.create(env.bob, blocks=300_000, uptime=9990)
        env.activate()
        env.advance(20 * 86400)  # nobody probed: unprobed time counts as up
        env.healthy()
        assert env.probe(pid)["ok"]
        env.fail()
        rounds = [env.next_probe(pid) for _ in range(5)]
        assert all(r["verdict"] == "FAILING" for r in rounds)
        assert not any(r["breach_staged"] for r in rounds)
        p = env.policy(pid)
        assert p["uptime_bps"] >= 9990 and p["consecutive_failures"] == 5 and p["status"] == "ACTIVE"

    # --- 4. vesting and stake-bound protection -----------------------------
    def test_payouts_cannot_instantly_drain_the_pool(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.activate()
        env.advance(8 * 86400)
        env.healthy()
        env.probe(pid)
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        env.advance(GRACE + 1)
        tvl = int(env.metrics()["tvl"])
        env.settle(pid)
        assert env.paid_to(env.bob) == 0 and int(env.metrics()["tvl"]) == tvl  # confirmation moves no funds
        env.advance(COOLDOWN - 1)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.release(pid)
        env.advance(1 + VEST // 10)
        env.release(pid)
        assert 0 < env.paid_to(env.bob) <= 10 * ATTO // 10 + 1  # a tenth of the stream after a tenth of the time

    def test_cover_bought_on_an_already_dead_node_never_pays(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.fail("down")  # dead from the start; references healthy
        for _ in range(12):
            env.next_probe(pid)
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and not p["baseline_ok"] and p["consecutive_failures"] == 12
        assert env.metrics()["reserved_payouts"] == "0"

    def test_no_instant_claim_after_purchase(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.fail("down")
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)

    def test_self_dealing_on_a_fresh_policy_gets_a_quarter_of_cover_and_late(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.settle(pid, who=env.bob)  # the operator settles their own claim
        assert env.policy(pid)["status"] == "VESTING"
        assert int(env.policy(pid)["payout"]) < cov * 30 // 100
        assert env.paid_to(env.bob) == PROBE_BOND  # only their own bond back; payout is still vesting

    def test_one_operator_cannot_concentrate_the_pool(self, funded):
        env = funded
        a = env.distinct_holders(1)[0]
        env.create(a, endpoint="alpha-rpc", coverage=10 * ATTO)
        env.create(a, endpoint="beta-rpc", coverage=10 * ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(a, endpoint="gamma-rpc", coverage=10 * ATTO)

    def test_single_policy_loss_is_bounded_by_pool_share(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.activate()
        env.advance(8 * 86400)
        env.healthy()
        env.probe(pid)
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        env.advance(GRACE + 1)
        env.settle(pid)
        env.advance(COOLDOWN + VEST)
        env.release(pid)
        assert int(env.metrics()["tvl"]) >= 90 * ATTO  # <= 10% of the original pool lost


# ============================================================================
# Pool solvency invariants
# ============================================================================
def _two_provider_book(env):
    """Four 10-GEN policies: alpha and beta, two holders each."""
    h1, h2 = env.distinct_holders(2)
    return [
        env.create(h1, endpoint="alpha-rpc", coverage=10 * ATTO),
        env.create(h1, endpoint="beta-rpc", coverage=10 * ATTO),
        env.create(h2, endpoint="alpha-rpc", coverage=10 * ATTO),
        env.create(h2, endpoint="beta-rpc", coverage=10 * ATTO),
    ]


def _breach_book(env, age_days):
    pids = _two_provider_book(env)
    env.activate()
    env.advance(age_days * 86400)
    env.healthy()
    for pid in pids:
        assert env.probe(pid)["ok"]
    env.mock_many({"alpha-rpc": ("status", 502), "beta-rpc": ("status", 502)}, default="head")
    for _ in range(4):
        env.advance(301)
        for pid in pids:
            env.probe(pid)
    env.advance(GRACE + 1)
    return pids


class TestInvariants:
    @pytest.mark.parametrize("age_days", [0, 8])
    def test_solvency_under_simultaneous_breach_of_every_policy(self, funded, age_days):
        env = funded
        pids = _breach_book(env, age_days)
        assert all(env.policy(pid)["status"] == "BREACH_PENDING" for pid in pids)
        m = env.metrics()
        assert m["reserved_payouts"] == m["locked_coverage"] == str(40 * ATTO)
        env.assert_solvent()

        epochs, total = 0, 0
        for pid in pids:
            while True:
                try:
                    total += int(env.settle(pid)["payout"])
                    break
                except Exception as exc:  # claim velocity ceiling: the claim waits for the next epoch
                    assert "[VELOCITY_LIMIT]" in str(exc)
                    env.advance(86_400 + 1)
                    epochs += 1
            env.assert_solvent()
        assert epochs == (1 if age_days else 0)  # 4 x 10 GEN against a 30% ceiling needs a second epoch
        m = env.metrics()
        assert m["owed_payouts"] == str(total) and m["active_policies"] == 0 and m["total_payouts"] == "0"
        if age_days:
            assert total == 40 * ATTO
        else:
            assert total < 40 * ATTO * 30 // 100

        env.advance(COOLDOWN + VEST)
        for pid in pids:
            assert env.release(pid)["done"]
        m = env.metrics()
        assert m["locked_coverage"] == "0" and m["reserved_payouts"] == "0" and m["owed_payouts"] == "0"
        assert m["total_payouts"] == str(total)
        assert int(m["tvl"]) == 100 * ATTO + int(m["total_premiums"]) + int(m["total_bond_forfeits"]) - total
        env.assert_solvent()

    def test_payout_never_exceeds_policy_coverage_or_pool(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO, blocks=300_000)  # ~42 days
        env.activate()
        env.advance(30 * 86400)
        env.healthy()
        env.probe(pid)
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        env.advance(GRACE + 1)
        paid = int(env.settle(pid)["payout"])
        assert paid == 10 * ATTO and paid <= 100 * ATTO

    def test_share_price_never_falls_without_a_payout(self, funded):
        env = funded
        last = int(env.metrics()["share_price"])
        env.create(env.bob)
        assert int(env.metrics()["share_price"]) > last
        last = int(env.metrics()["share_price"])
        env.activate()
        env.healthy()
        env.probe(env.contract.get_policy_count())  # healthy: bond forfeit adds yield
        assert int(env.metrics()["share_price"]) >= last

    def test_unauthorized_actions_rejected(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        env.probe(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)  # nothing staged: no payout possible
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.release(pid)  # nothing vesting
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.contract.expire_policy(pid)  # cannot cut a live policy short
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.bob, 1)  # policyholders have no underwriting position
        with env.vm.expect_revert("[UNAUTHORIZED]"):
            env.vm.sender = env.bob
            env.contract.transfer_governor(env.hex(env.bob))
        assert env.metrics()["total_payouts"] == "0"

    def test_pool_metrics_shape(self, funded):
        env = funded
        m = env.metrics()
        for k in ("tvl", "utilization_bps", "apy_bps", "free_liquidity", "locked_coverage", "reserved_payouts",
                  "owed_payouts", "staged_claims", "share_price", "active_policies", "listed_endpoints", "solvent"):
            assert k in m
        assert m["solvent"] is True and m["utilization_bps"] == 0 and m["listed_endpoints"] == len(PROVIDERS)


# ============================================================================
# Reference-head poisoning: a Byzantine leader and the height bounds
# ============================================================================
class TestByzantineLeader:
    @pytest.fixture
    def probed(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.mock(target=1_000, refs=1_000)
        assert env.probe(pid)["block"] == 1_000
        return env, pid

    @pytest.mark.parametrize(
        "height,expected",
        [(1_000, True), (1_002, True), (1_003, False), (1_010, False), (990, True), (989, False)],
    )
    def test_leader_may_trail_by_ten_but_lead_by_at_most_two(self, probed, height, expected):
        env, _ = probed
        assert env.vm.run_validator(leader_result=leader_round(env, height)) is expected

    @pytest.mark.parametrize("height", [-5, -2, 0, 10**18, 2**53 + 1, 10**30])
    def test_negative_zero_and_absurd_heights_are_rejected(self, probed, height):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=leader_round(env, height, ref_blocks=[height] * 4))

    @pytest.mark.parametrize("height", ["1000", 1000.0, True, None])
    def test_non_integer_heights_are_rejected(self, probed, height):
        env, _ = probed
        forged = leader_round(env, 1_000)
        for ref in forged["refs"]:
            ref["block"] = height  # a non-integer reference height smuggled into otherwise honest telemetry
        assert not env.vm.run_validator(leader_result=forged)
        forged = leader_round(env, 1_000)
        forged["block"] = height  # ...or a non-integer target height
        assert not env.vm.run_validator(leader_result=forged)

    def test_poisoned_high_reference_head_is_rejected_even_when_the_verdict_matches(self, probed):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=leader_round(env, 10**9))

    def test_poisoned_low_reference_head_is_rejected(self, probed):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=leader_round(env, 5))

    def test_validator_measures_its_own_height(self, probed):
        env, _ = probed
        env.mock(target=1_005, refs=1_005)  # the validator's vantage point is a few blocks ahead: still honest
        assert env.vm.run_validator(leader_result=leader_round(env, 1_000))
        env.mock(target=1_100, refs=1_100)  # but not 100 blocks ahead
        assert not env.vm.run_validator(leader_result=leader_round(env, 1_000))
        env.mock(target=990, refs=990)  # a leader 10 ahead of the validator's view is a poisoning attempt
        assert not env.vm.run_validator(leader_result=leader_round(env, 1_000))

    def test_a_healthy_verdict_requires_a_target_height(self, probed):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=leader_round(env, -1, 1_000))


# ============================================================================
# Freshness against corroborated references
# ============================================================================
class TestFreshness:
    def test_a_genuinely_frozen_node_is_detected_and_breaches(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]
        frozen = env.head
        env.mock(target=frozen, refs="head")  # target stops advancing; the chain does not
        reasons = []
        for _ in range(14):
            r = env.next_probe(pid)
            reasons.append(r["reason"])
            if r["breach_staged"]:
                break
        assert env.policy(pid)["status"] == "BREACH_PENDING"
        assert "STALE_BLOCK" in reasons and reasons[0] == "OK"  # the first rounds are inside the tolerance

    def test_a_node_that_is_merely_a_few_blocks_behind_never_breaches(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.fail(("lag", 10))  # a load-balanced backend trailing the head
        for _ in range(20):
            r = env.next_probe(pid)
            assert r["verdict"] == "HEALTHY"
        assert env.policy(pid)["status"] == "ACTIVE" and env.policy(pid)["consecutive_failures"] == 0


# ============================================================================
# LP early exit and deposit arbitrage
# ============================================================================
class TestUnderwriterEarlyExit:
    def _two_lps_with_pending_claim(self, env):
        env.deposit(env.alice, 50 * ATTO)
        env.deposit(env.owner, 50 * ATTO)
        pid = env.create(env.bob, coverage=10 * ATTO, blocks=100_000)
        env.activate()
        env.advance(8 * 86_400)  # fully vested: the claim will pay 100% of coverage
        env.healthy()
        env.probe(pid)
        env.fail()
        for _ in range(4):
            env.next_probe(pid)
        assert env.policy(pid)["status"] == "BREACH_PENDING"
        return pid

    def test_redemptions_are_priced_net_of_reserved_payouts(self, env):
        pid = self._two_lps_with_pending_claim(env)
        m = env.metrics()
        assert int(m["net_assets"]) == int(m["tvl"]) - 10 * ATTO == int(m["tvl"]) - int(m["reserved_payouts"])
        assert int(m["share_price"]) < ATTO * int(m["tvl"]) // int(m["total_shares"])
        pos = env.contract.get_underwriter(env.hex(env.alice))
        assert int(pos["value"]) == int(pos["shares"]) * int(m["net_assets"]) // int(m["total_shares"])
        assert pid == 1

    def test_early_exit_cannot_dump_the_pending_loss_on_remaining_lps(self, env):
        pid = self._two_lps_with_pending_claim(env)
        before = env.metrics()
        env.transfers.clear()
        value = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        env.withdraw(env.alice, value)  # Alice front-runs the settlement
        exit_amount = env.paid_to(env.alice)
        assert exit_amount < int(before["tvl"]) // 2 - 4 * ATTO
        env.advance(GRACE + 1)
        assert env.settle(pid)["payout"] == str(10 * ATTO)
        owner_value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        assert abs(owner_value - exit_amount) <= 10**9, (owner_value, exit_amount)  # both bore the loss equally
        env.assert_solvent()

    def test_staying_lps_do_not_lose_more_than_their_share(self, env):
        pid = self._two_lps_with_pending_claim(env)
        before = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        env.advance(GRACE + 1)
        env.settle(pid)
        after = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        assert abs(after - before) <= 10**9
        env.advance(COOLDOWN + VEST)
        env.release(pid)  # the stream itself never changes net asset value
        assert abs(int(env.contract.get_underwriter(env.hex(env.alice))["value"]) - before) <= 10**9

    def test_withdrawal_cannot_infringe_reserved_capital(self, env):
        self._two_lps_with_pending_claim(env)
        tvl = int(env.metrics()["tvl"])
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, tvl - 9 * ATTO)  # more than the net position value
        free = int(env.metrics()["free_liquidity"])
        assert free == tvl - 10 * ATTO

    def test_deposits_are_frozen_while_a_claim_is_staged(self, env):
        self._two_lps_with_pending_claim(env)
        assert int(env.metrics()["staged_claims"]) > 0
        shares_before = env.metrics()["total_shares"]
        with env.vm.expect_revert("[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"):
            env.deposit(env.charlie, 10 * ATTO)
        assert env.metrics()["total_shares"] == shares_before  # nothing was minted

    def test_deposits_reopen_at_net_price_once_the_claim_is_confirmed(self, env):
        """A confirmed payout is a certain liability: it is already outside net assets, so it need not freeze deposits."""
        pid = self._two_lps_with_pending_claim(env)
        env.advance(GRACE + 1)
        env.settle(pid)
        m = env.metrics()
        assert m["staged_claims"] == "0" and m["owed_payouts"] == str(10 * ATTO)
        assert int(m["net_assets"]) == int(m["tvl"]) - 10 * ATTO
        minted = int(env.deposit(env.charlie, 10 * ATTO))
        assert minted == 10 * ATTO * int(m["total_shares"]) // int(m["net_assets"])
        # the new LP bought in at fair value: their position is worth what they paid (to rounding)
        value = int(env.contract.get_underwriter(env.hex(env.charlie))["value"])
        assert 10 * ATTO - 10**9 <= value <= 10 * ATTO

    def test_reviewer_poc_staging_a_breach_cannot_buy_discounted_shares(self, env):
        """Stage a claim, try to buy cheap LP shares, let the claim be dismissed: no risk-free profit and no dilution."""
        pid = self._two_lps_with_pending_claim(env)
        before = {w: int(env.contract.get_underwriter(env.hex(w))["value"]) for w in (env.alice, env.owner)}
        with env.vm.expect_revert("[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"):
            env.deposit(env.charlie, 50 * ATTO)
        env.advance(GRACE + 1)
        env.healthy()
        assert env.settle(pid)["confirmed"] is False
        after = {w: int(env.contract.get_underwriter(env.hex(w))["value"]) for w in (env.alice, env.owner)}
        assert env.metrics()["total_shares"] == str(100 * ATTO)  # no shares were ever minted to the attacker
        for w in before:
            assert after[w] >= before[w]  # existing LPs are never diluted: their value only rises
        m = env.metrics()
        assert env.deposit(env.charlie, 10 * ATTO) == str(10 * ATTO * int(m["total_shares"]) // int(m["tvl"]))

    def test_a_dismissed_claim_returns_the_reserved_value_to_everyone(self, env):
        pid = self._two_lps_with_pending_claim(env)
        gross = int(env.metrics()["tvl"])
        env.advance(GRACE + 1)
        env.healthy()
        assert env.settle(pid)["confirmed"] is False
        m = env.metrics()
        assert int(m["net_assets"]) == int(m["tvl"]) and int(m["tvl"]) > gross


# ============================================================================
# Provider-domain caps and registrable-domain extraction
# ============================================================================
class TestProviderDomainCaps:
    def test_listings_under_one_registrable_domain_share_one_cap(self, bare):
        env = bare
        for endpoint_id, provider, domain in PROVIDERS[:4]:
            env.register(endpoint_id, provider, domain)
        env.register("shared-a", "Shared A", "node-shared.io", url="https://a.node-shared.io")
        env.register("shared-b", "Shared B", "node-shared.io", url="https://b.node-shared.io")
        env.advance(LISTING_DELAY + 1)
        env.deposit(env.owner, 100 * ATTO)
        a, b, c = env.distinct_holders(3)
        env.create(a, endpoint="shared-a", coverage=10 * ATTO)
        env.create(b, endpoint="shared-b", coverage=10 * ATTO)  # the registrable domain is now at 20%
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, endpoint="shared-a", coverage=ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, endpoint="shared-b", coverage=ATTO)
        env.create(c, endpoint="alpha-rpc", coverage=ATTO)  # a different provider is fine

    @pytest.mark.parametrize(
        "host,domain,apex",
        [
            ("rpc.node.io", "node.io", "node.io"),
            ("a.b.c.node.io", "node.io", "node.io"),
            ("rpc.example.co.uk", "example.co.uk", "example.co.uk"),
            ("a.b.example.com.au", "example.com.au", "example.com.au"),
            ("my-node.vercel.app", "my-node.vercel.app", "my-node.vercel.app"),
            ("x.my-node.vercel.app", "my-node.vercel.app", "my-node.vercel.app"),
        ],
    )
    def test_apex_extraction(self, env, host, domain, apex):
        env.register("apex-test", "Apex Test", domain, url=f"https://{host}")
        assert env.contract.get_endpoint("apex-test")["apex"] == apex

    def test_platform_tenants_do_not_share_a_cap(self, env):
        env.deposit(env.owner, 100 * ATTO)
        env.register("tenant-a", "Tenant A", "one.vercel.app", url="https://one.vercel.app")
        env.register("tenant-b", "Tenant B", "two.vercel.app", url="https://two.vercel.app")
        env.advance(LISTING_DELAY + 1)
        a, b = env.distinct_holders(2)
        env.create(a, endpoint="tenant-a", coverage=10 * ATTO)
        env.create(b, endpoint="tenant-a", coverage=10 * ATTO)
        env.create(a, endpoint="tenant-b", coverage=10 * ATTO)  # separate tenant, separate cap

    def test_provider_exposure_is_released_on_close(self, funded):
        env = funded
        a, b = env.distinct_holders(2)
        pid = env.create(a, coverage=10 * ATTO, blocks=300)
        env.create(b, coverage=10 * ATTO)
        env.advance(ACTIVATION + 300 * 12)
        env.contract.expire_policy(pid)
        env.create(a, coverage=10 * ATTO)  # room again


# ============================================================================
# Claim velocity
# ============================================================================
class TestClaimVelocity:
    def test_confirmations_beyond_the_epoch_ceiling_wait_for_the_next_epoch(self, funded):
        env = funded
        pids = _breach_book(env, 8)
        ceiling = int(env.metrics()["epoch_ceiling"])
        assert ceiling == int(env.metrics()["tvl"]) * 3000 // 10_000
        for pid in pids[:3]:
            assert env.settle(pid)["confirmed"]
        assert int(env.metrics()["epoch_paid"]) == 30 * ATTO
        before = env.metrics()
        with env.vm.expect_revert("[VELOCITY_LIMIT]"):
            env.settle(pids[3])
        after = env.metrics()
        assert env.policy(pids[3])["status"] == "BREACH_PENDING"  # a rejected settlement changes nothing
        assert (after["tvl"], after["reserved_payouts"], after["total_probes"]) == (before["tvl"], before["reserved_payouts"], before["total_probes"])
        env.advance(86_400 + 1)
        assert int(env.metrics()["epoch_paid"]) == 0  # the new epoch starts clean
        assert env.settle(pids[3])["confirmed"]
        env.assert_solvent()

    def test_a_single_epoch_can_never_confirm_more_than_the_ceiling(self, funded):
        env = funded
        pids = _breach_book(env, 8)
        tvl_before = int(env.metrics()["tvl"])
        confirmed = 0
        for pid in pids:
            try:
                confirmed += int(env.settle(pid)["payout"])
            except Exception as exc:
                assert "[VELOCITY_LIMIT]" in str(exc)
        assert confirmed == 30 * ATTO and confirmed <= tvl_before * 3000 // 10_000

    def test_dismissals_are_not_rate_limited(self, funded):
        env = funded
        pids = _breach_book(env, 8)
        env.healthy()  # everything recovered during the grace period
        for pid in pids:
            assert env.settle(pid)["confirmed"] is False
        assert env.metrics()["epoch_paid"] == "0"

    def test_every_claim_is_eventually_confirmed_inside_the_settlement_window(self, funded):
        env = funded
        pids = _breach_book(env, 8)
        days = 0
        while any(env.policy(pid)["status"] == "BREACH_PENDING" for pid in pids):
            for pid in pids:
                if env.policy(pid)["status"] == "BREACH_PENDING":
                    try:
                        env.settle(pid)
                    except Exception as exc:
                        assert "[VELOCITY_LIMIT]" in str(exc)
            env.advance(86_400 + 1)
            days += 1
            assert days <= 10, "queue failed to drain"
        assert all(env.policy(pid)["status"] == "VESTING" for pid in pids)
        assert days <= 7  # well inside the 14-day settlement window
        env.assert_solvent()


# ============================================================================
# Audit regressions (PulseSLA-review, findings 1-4): each test is the audit's
# proof of concept, now required to FAIL to reproduce the exploit.
# ============================================================================
SHORT_BLOCKS = 300  # the one-hour minimum term


class TestAuditRegressions:
    # --- P1-1: orphaned capital ------------------------------------------------
    def test_last_lp_cannot_burn_every_share_behind_a_staged_claim(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        assert env.policy(pid)["status"] == "BREACH_PENDING"
        net_value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, net_value)  # the audit's step 2
        assert int(env.metrics()["total_shares"]) > 0

    def test_new_depositor_cannot_capture_released_reserve(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        env.withdraw(env.owner, value - 2 * 10**12)  # as close to a full exit as the guards allow
        owner_shares = int(env.contract.get_underwriter(env.hex(env.owner))["shares"])
        assert owner_shares > 0
        # the endpoint recovers and the claim is dismissed: the reserve is released
        env.advance(GRACE + 1)
        env.healthy()
        assert env.settle(pid)["confirmed"] is False
        assert env.policy(pid)["status"] == "ACTIVE"
        freed = int(env.metrics()["tvl"])
        assert freed >= 10 * ATTO
        # a 0.001 GEN depositor buys in at the real price and owns almost none of it
        env.deposit(env.alice, 10**15)
        alice_value = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        assert alice_value <= 10**15 + 1
        owner_value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        assert owner_value >= freed - 10**15 - 1  # the capital stayed with the LP who stayed
        env.assert_solvent()

    def test_partial_payout_surplus_stays_with_the_remaining_lp(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        env.withdraw(env.owner, value - 2 * 10**12)
        env.advance(GRACE + 1)
        payout = int(env.settle(pid)["payout"])
        assert payout < cov  # partial: the rest of the reserve is freed
        env.deposit(env.alice, 10**15)
        assert int(env.contract.get_underwriter(env.hex(env.alice))["value"]) <= 10**15 + 1
        assert int(env.contract.get_underwriter(env.hex(env.owner))["value"]) > 0
        env.assert_solvent()

    def test_a_position_cannot_be_shrunk_to_a_dust_sliver_behind_a_reserve(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        with env.vm.expect_revert("dust-sized"):
            env.withdraw(env.owner, value - 1000)

    def test_reported_withdrawable_is_exactly_what_the_contract_accepts(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.stage_breach(pid)
        w = int(env.contract.get_underwriter(env.hex(env.owner))["withdrawable"])
        assert w > 0
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, w + 1)
        env.withdraw(env.owner, w)
        assert int(env.contract.get_underwriter(env.hex(env.owner))["shares"]) > 0

    def test_full_exit_is_allowed_once_nothing_is_locked_and_leaves_no_residue(self, funded):
        env = funded
        env.withdraw(env.owner, int(env.contract.get_underwriter(env.hex(env.owner))["value"]))
        m = env.metrics()
        assert int(m["total_shares"]) == 0 and int(m["tvl"]) == 0

    # --- P1-2: unbounded gap between failing observations ---------------------
    def test_failures_on_separate_days_do_not_form_one_outage(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO, blocks=100_000, uptime=9990, interval=150)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]
        for _ in range(3):
            env.advance(24 * 3600)  # a whole day passes unobserved
            env.fail()
            r = env.probe(pid)  # a one-second blip caught by the sampler
            assert r["verdict"] == "FAILING" and r["breach_staged"] is False
            assert r["consecutive_failures"] == 1  # every failure starts a NEW streak
            env.healthy()  # recovered immediately; nobody recorded it
        p = env.policy(pid)
        assert p["status"] == "ACTIVE"
        assert int(p["downtime_secs"]) == 3 * 1800  # three bounded credits, never 72 h

    def test_a_streak_survives_a_gap_up_to_the_limit_and_breaks_beyond_it(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO, interval=150)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        env.advance(1801)
        assert env.probe(pid)["consecutive_failures"] == 1
        env.advance(3600)  # exactly MAX_PROBE_GAP_SECS: still the same outage
        assert env.probe(pid)["consecutive_failures"] == 2
        env.advance(3601)  # one second too long: a new outage
        assert env.probe(pid)["consecutive_failures"] == 1

    def test_a_healthy_round_clears_the_streak_clock(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO, interval=150)
        env.activate()
        env.healthy()
        env.probe(pid)
        env.fail()
        env.advance(1801)
        env.probe(pid)
        env.healthy()
        env.advance(1801)
        assert env.probe(pid)["ok"]
        env.fail()
        env.advance(1801)
        r = env.probe(pid)
        assert r["consecutive_failures"] == 1 and env.policy(pid)["outage_started_at"] == env.now

    # --- P2-3: settlement delay and post-expiry observation -------------------
    def test_waiting_after_expiry_cannot_inflate_or_confirm_a_stale_claim(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov, blocks=SHORT_BLOCKS, uptime=9900, interval=25)
        env.stage_breach(pid)
        assert env.policy(pid)["status"] == "BREACH_PENDING"
        first = vested(cov, env.policy(pid)["breach_at"] - env.policy(pid)["active_from"])
        env.healthy()  # recovered; nobody settled
        env.advance(7 * 24 * 3600)  # a week later, long after the one-hour term
        env.fail()  # a fresh, unrelated failure
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.probe(pid)
        assert first < cov  # the audit's 10 GEN outcome is unreachable
        assert env.contract.expire_policy(pid) == "LAPSED"
        assert env.policy(pid)["status"] == "LAPSED"
        assert int(env.metrics()["reserved_payouts"]) == 0
        env.assert_solvent()

    def test_in_term_settlement_delay_does_not_raise_the_payout(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov, blocks=100_000, interval=25)
        env.stage_breach(pid)
        p = env.policy(pid)
        expected = vested(cov, p["breach_at"] - p["active_from"])
        env.advance(5 * 24 * 3600)  # waits days, still inside the term
        env.fail()
        r = env.settle(pid)
        assert r["confirmed"] and int(r["payout"]) == expected
        assert expected < vested(cov, env.now - p["active_from"])  # the old, inflated figure

    def test_a_claim_that_cannot_be_reverified_in_term_is_not_staged(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO, blocks=SHORT_BLOCKS, uptime=9900, interval=25)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]
        expires = int(env.policy(pid)["expires_at"])
        env.fail()
        env.advance(expires - env.now - 4 * 301 - 100)  # the outage completes with < GRACE left
        last = None
        for _ in range(4):
            last = env.next_probe(pid)
        assert last["consecutive_failures"] == 4 and last["breach_staged"] is False
        assert env.policy(pid)["status"] == "ACTIVE"

    # --- P2-4: unpayable terms ---------------------------------------------
    def test_one_hour_policy_with_a_day_long_interval_is_rejected(self, funded):
        env = funded
        env.fund(env.bob)
        env.vm.sender, env.vm.value = env.bob, 10**18
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.contract.create_policy(ALPHA, 5 * ATTO, SHORT_BLOCKS, 9990, 7200)

    def test_term_too_short_for_the_chosen_sla_is_rejected_before_premium(self, funded):
        env = funded
        need = int(env.contract.min_insurable_duration(9000, 150))
        assert need > SHORT_BLOCKS
        env.fund(env.bob)
        env.vm.sender, env.vm.value = env.bob, 10**19
        with env.vm.expect_revert("term too short"):
            env.contract.create_policy(ALPHA, 5 * ATTO, need - 1, 9000, 150)
        assert env.paid_to(env.bob) == 0 and int(env.metrics()["tvl"]) == 100 * ATTO
        env.vm.value = 10**19
        env.contract.create_policy(ALPHA, 5 * ATTO, need, 9000, 150)

    @pytest.mark.parametrize("uptime,interval", [(9000, 150), (9500, 150), (9900, 25), (9990, 5), (9999, 60), (9900, 150)])
    def test_every_accepted_minimum_term_is_actually_payable(self, funded, uptime, interval):
        env = funded
        blocks = int(env.contract.min_insurable_duration(uptime, interval))
        pid = env.create(env.bob, coverage=5 * ATTO, blocks=blocks, uptime=uptime, interval=interval)
        env.activate()
        env.healthy()
        assert env.probe(pid)["ok"]
        env.fail()
        staged = False
        for _ in range(200):
            env.advance(interval * 12)  # best-case keeper: exactly one round per interval
            r = env.probe(pid)
            if r["breach_staged"]:
                staged = True
                break
        assert staged, "an accepted term must be able to stage a claim"
        env.advance(GRACE)
        assert env.settle(pid)["confirmed"]
