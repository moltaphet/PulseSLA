"""PulseSLA contract tests -- genlayer-test direct mode (in-memory GenVM).

Sections: underwriting arithmetic, premium pricing, policy creation & caps,
policy expiry, probe scenarios (healthy / 502 / 504 / timeout / latency / stale
block), validator-consensus rules, staged claims, collusion resistance, and the
pool-solvency invariants under simultaneous breach.
"""

import json

import pytest

from tests.conftest import ACTIVATION, ATTO, GRACE, PROBE_BOND

YEAR = 365 * 24 * 3600
BLOCKS_PER_YEAR = YEAR // 12


def premium_formula(cov: int, blocks: int, uptime: int) -> int:
    rate = 800 if uptime >= 9990 else 400 if uptime >= 9900 else 200
    p = cov * rate * (blocks * 12) // (10000 * YEAR)
    return max(p, cov * 10 // 10000)


def vested(cov: int, age: int) -> int:
    if age >= 7 * 86400:
        return cov
    return cov * (2500 + 7500 * max(age, 0) // (7 * 86400)) // 10000


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
# Policy creation: validation and exposure caps
# ============================================================================
BAD_URLS = [
    "http://localhost:8545",
    "https://localhost",
    "http://127.0.0.1:8545",
    "http://10.0.0.5/rpc",
    "http://192.168.1.1",
    "http://172.16.0.9",
    "http://169.254.169.254/latest/meta-data",
    "https://user:pw@rpc.example.com",
    "http://0x7f000001",
    "http://2130706433",
    "http://127.1",
    "ftp://rpc.example.com",
    "https://rpc.internal",
    "https://box.local",
    "https://10.0.0.1.nip.io",
    "http://[::1]:8545/",
    "https://rpc.example.com\\@127.0.0.1",
    " https://rpc.example.com",
    "",
]


class TestCreatePolicy:
    @pytest.mark.parametrize("url", BAD_URLS)
    def test_unsafe_urls_rejected(self, funded, url):
        env = funded
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.create(env.bob, url=url, value=ATTO)

    @pytest.mark.parametrize("url", ["https://eth-mainnet.g.alchemy.com/v2/key", "http://8.8.8.8:8545", "https://RPC.Example.COM/path?x=1"])
    def test_public_urls_accepted(self, funded, url):
        env = funded
        pid = env.create(env.bob, url=url)
        assert env.policy(pid)["status"] == "ACTIVE"

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"latency": 49},
            {"latency": 30001},
            {"coverage": 10**15 - 1},
            {"blocks": 299},
            {"blocks": 2_628_001},
            {"uptime": 8999},
            {"uptime": 10000},
            {"interval": 4},
            {"interval": 7201},
            {"mode": "grpc"},
        ],
    )
    def test_parameter_bounds(self, funded, kwargs):
        env = funded
        with env.vm.expect_revert("[INVALID_PARAMS]"):
            env.create(env.bob, value=ATTO, **kwargs)

    def test_policy_record_and_schedule(self, funded):
        env = funded
        created = env.now
        pid = env.create(env.bob, latency=750, coverage=4 * ATTO, blocks=1000, uptime=9900, interval=10, mode="http")
        p = env.policy(pid)
        assert pid == 1 and env.contract.get_policy_count() == 1
        assert p["holder"].lower() == env.hex(env.bob)
        assert (p["host"], p["probe_mode"], p["max_latency_ms"]) == ("rpc.node-alpha.io", "http", 750)
        assert p["coverage"] == str(4 * ATTO) and p["min_uptime_bps"] == 9900
        assert p["probe_interval"] == 120
        assert p["active_from"] == created + ACTIVATION
        assert p["expires_at"] == created + ACTIVATION + 1000 * 12
        assert env.metrics()["locked_coverage"] == str(4 * ATTO)

    def test_empty_pool_cannot_write_policies(self, env):
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(env.bob, value=ATTO)

    def test_per_policy_cap(self, funded):
        env = funded
        env.create(env.bob, coverage=10 * ATTO)  # exactly 10% of 100 GEN
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(env.alice, url="https://rpc.other-node.io", coverage=11 * ATTO)

    def test_per_host_cap(self, funded):
        env = funded
        a, b, c = env.distinct_holders(3)
        env.create(a, coverage=10 * ATTO)
        env.create(b, coverage=10 * ATTO)  # host now at 20%
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, coverage=ATTO)
        env.create(c, url="https://rpc.node-beta.io", coverage=ATTO)  # other host is fine

    def test_per_holder_cap(self, funded):
        env = funded
        a = env.distinct_holders(1)[0]
        env.create(a, url="https://rpc.one-node.io", coverage=10 * ATTO)
        env.create(a, url="https://rpc.two-node.io", coverage=10 * ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(a, url="https://rpc.three-node.io", coverage=ATTO)

    def test_utilization_cap(self, funded):
        env = funded
        holders = env.distinct_holders(5)
        for i in range(8):
            env.create(holders[i // 2], url=f"https://rpc.apex{i // 2}.io", coverage=10 * ATTO)
        assert int(env.metrics()["utilization_bps"]) <= 8000
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(holders[4], url="https://rpc.apex9.io", coverage=5 * ATTO)
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
        # host / holder caps are free again
        env.create(env.bob, coverage=10 * ATTO)
        env.create(env.bob, coverage=10 * ATTO)

    def test_expired_policy_cannot_be_probed(self, funded):
        env = funded
        pid = env.create(env.bob, blocks=300)
        env.advance(ACTIVATION + 300 * 12 + 1)
        env.rpc(100)
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
# Probes under mocked web consensus
# ============================================================================
class TestProbes:
    @pytest.fixture
    def pol(self, funded):
        env = funded
        pid = env.create(env.bob, latency=500)
        env.activate()
        return env, pid

    def test_healthy_response(self, pol):
        env, pid = pol
        env.rpc(block=12345)
        tvl = int(env.metrics()["tvl"])
        r = env.probe(pid)
        assert r["ok"] and r["reason"] == "OK" and r["status"] == 200 and r["block"] == 12345
        p = env.policy(pid)
        assert p["baseline_ok"] and p["samples_ok"] == 1 and p["last_block"] == 12345 and p["uptime_bps"] == 10000
        # a probe that finds nothing wrong forfeits the spam bond to underwriters
        assert int(env.metrics()["tvl"]) == tvl + PROBE_BOND
        assert env.paid_to(env.charlie) == 0

    @pytest.mark.parametrize("status", [500, 502, 503, 504, 404, 429])
    def test_http_error_statuses_fail(self, pol, status):
        env, pid = pol
        env.rpc(status=status)
        tvl = int(env.metrics()["tvl"])
        r = env.probe(pid)
        assert not r["ok"] and r["reason"] == "HTTP_ERROR" and r["status"] == status
        assert env.policy(pid)["consecutive_failures"] == 1
        # useful probe: bond refunded in full, pool unchanged
        assert env.paid_to(env.charlie) == PROBE_BOND
        assert int(env.metrics()["tvl"]) == tvl

    def test_timeout_unreachable(self, pol):
        env, pid = pol
        env.down()
        r = env.probe(pid)
        assert not r["ok"] and r["reason"] == "UNREACHABLE" and r["status"] == 0

    def test_latency_over_limit_fails(self, pol):
        env, pid = pol
        env.rpc(100)
        env.latency_ms = 501
        r = env.probe(pid)
        assert not r["ok"] and r["reason"] == "HIGH_LATENCY" and r["latency_ms"] == 501

    def test_latency_at_limit_passes(self, pol):
        env, pid = pol
        env.rpc(100)
        env.latency_ms = 500
        assert env.probe(pid)["ok"]

    def test_stale_block_height_fails(self, pol):
        env, pid = pol
        env.rpc(500)
        assert env.probe(pid)["ok"]
        r = env.next_probe(pid)  # same height a minute later -> frozen node
        assert not r["ok"] and r["reason"] == "STALE_BLOCK"
        env.rpc(501)
        assert env.next_probe(pid)["ok"]

    def test_regressing_block_height_is_stale(self, pol):
        env, pid = pol
        env.rpc(500)
        env.probe(pid)
        env.rpc(499)
        assert env.next_probe(pid)["reason"] == "STALE_BLOCK"

    @pytest.mark.parametrize(
        "body",
        ['{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"boom"}}', "not json", "{}", '{"result":"abc"}', '{"result":"0x"}', "[]"],
    )
    def test_invalid_payload_fails(self, pol, body):
        env, pid = pol
        env.rpc(body=body)
        r = env.probe(pid)
        assert not r["ok"] and r["reason"] == "BAD_PAYLOAD"

    def test_http_mode_checks_status_and_latency_only(self, funded):
        env = funded
        pid = env.create(env.bob, mode="http", latency=300)
        env.activate()
        env.http(200, "<html>ok</html>")
        r = env.probe(pid)
        assert r["ok"] and r["block"] == -1
        env.http(504)
        assert env.next_probe(pid)["reason"] == "HTTP_ERROR"

    def test_probe_interval_enforced(self, pol):
        env, pid = pol
        env.rpc(100)
        env.probe(pid)
        env.advance(30)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)
        env.advance(31)
        env.rpc(101)
        assert env.probe(pid)["ok"]

    def test_activation_delay_blocks_early_probes(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.advance(ACTIVATION - 10)
        env.rpc(100)
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)

    def test_probe_bond_required(self, pol):
        env, pid = pol
        env.rpc(100)
        with env.vm.expect_revert("[EXPECTED]"):
            env.probe(pid, bond=PROBE_BOND - 1)

    def test_excess_bond_is_refunded(self, pol):
        env, pid = pol
        env.rpc(100)
        env.probe(pid, bond=PROBE_BOND * 4)
        assert env.paid_to(env.charlie) == PROBE_BOND * 3

    def test_anyone_may_probe(self, pol):
        env, pid = pol
        env.rpc(100)
        assert env.probe(pid, who=env.alice)["ok"]

    def test_incident_log_records_probes(self, pol):
        env, pid = pol
        env.rpc(status=502)
        env.probe(pid)
        n = env.contract.get_incident_count()
        recs = [json.loads(s) for s in env.contract.get_incidents(0, 50)]
        assert n == len(recs) == 2
        assert recs[0]["kind"] == "POLICY_CREATED"
        assert recs[1]["kind"] == "PROBE" and recs[1]["status"] == 502 and recs[1]["ok"] is False
        assert "502" in recs[1]["detail"] and recs[1]["by"].lower() == env.hex(env.charlie)


# ============================================================================
# Validator consensus rules (the real validator closure, re-run by the harness)
# ============================================================================
class TestValidatorConsensus:
    @pytest.fixture
    def led(self, funded):
        env = funded
        pid = env.create(env.bob, latency=500)
        env.activate()
        return env, pid

    def test_validator_agrees_when_it_observes_the_same_verdict(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        assert env.vm.run_validator()

    def test_validator_agrees_on_failure_even_with_a_different_failure_class(self, led):
        env, pid = led
        env.rpc(status=502)
        env.probe(pid)
        env.rpc(status=504)
        assert env.vm.run_validator()
        env.down()
        assert env.vm.run_validator()

    def test_validator_rejects_a_leader_that_reports_failure_for_a_healthy_node(self, led):
        env, pid = led
        env.rpc(status=502)
        env.probe(pid)
        env.rpc(100)  # validator sees a healthy endpoint
        assert not env.vm.run_validator()

    def test_validator_rejects_a_leader_that_reports_healthy_for_a_dead_node(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        assert not env.vm.run_validator()

    def test_borderline_latency_split_is_tolerated(self, led):
        env, pid = led
        env.rpc(100)
        env.latency_ms = 560  # leader: HIGH_LATENCY (limit 500)
        assert not env.probe(pid)["ok"]
        env.latency_ms = 470  # validator: OK, but both inside +-20% of the limit
        assert env.vm.run_validator()

    def test_clear_latency_split_is_rejected(self, led):
        env, pid = led
        env.rpc(100)
        env.latency_ms = 900
        assert not env.probe(pid)["ok"]
        env.latency_ms = 50
        assert not env.vm.run_validator()

    def test_validator_rejects_leader_error(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        assert not env.vm.run_validator(leader_error=Exception("[LLM_ERROR] boom"))

    def test_validator_rejects_malformed_leader_result(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        assert not env.vm.run_validator(leader_result={"ok": True})
        assert not env.vm.run_validator(leader_result="healthy")

    def test_validator_rejects_self_contradicting_leader_result(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        forged = {"ok": True, "reason": "OK", "status": 502, "latency_ms": 5, "block": 100}
        assert not env.vm.run_validator(leader_result=forged)

    def test_validator_accepts_an_honest_leader_result(self, led):
        env, pid = led
        env.rpc(100)
        env.probe(pid)
        honest = {"ok": True, "reason": "OK", "status": 200, "latency_ms": 20, "block": 100}
        assert env.vm.run_validator(leader_result=honest)


# ============================================================================
# Staged claims: breach -> grace -> re-verification -> payout
# ============================================================================
class TestClaims:
    def test_three_consecutive_failures_stage_a_claim(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=5 * ATTO)
        env.activate()
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        r1, r2 = env.next_probe(pid), env.next_probe(pid)
        assert not r1["breach_staged"] and not r2["breach_staged"]
        assert env.policy(pid)["status"] == "ACTIVE"
        r3 = env.next_probe(pid)
        assert r3["breach_staged"]
        p = env.policy(pid)
        assert p["status"] == "BREACH_PENDING" and p["claim_count"] == 1
        assert p["settle_at"] == env.now + GRACE
        m = env.metrics()
        assert m["reserved_payouts"] == str(5 * ATTO) and m["total_breaches"] == 1
        env.assert_solvent()

    def test_recovery_resets_the_failure_streak(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        env.next_probe(pid)
        env.next_probe(pid)
        env.rpc(110)
        env.next_probe(pid)
        assert env.policy(pid)["consecutive_failures"] == 0
        env.rpc(status=502)
        env.next_probe(pid)
        env.next_probe(pid)
        assert env.policy(pid)["status"] == "ACTIVE"

    def test_gold_breaches_where_bronze_tolerates_the_same_outage(self, funded):
        env = funded
        gold = env.create(env.bob, uptime=9990, url="https://rpc.gold-node.io")
        bronze = env.create(env.alice, uptime=9000, url="https://rpc.bronze-node.io")
        env.activate()
        env.rpc(100)
        block = 100
        for _ in range(40):  # 40 healthy samples each
            block += 1
            env.rpc(block)
            env.advance(61)
            env.probe(gold)
            env.probe(bronze)
        env.rpc(status=502)
        for _ in range(3):  # then 3 failures: 40/43 = 93.0% uptime
            env.advance(61)
            env.probe(gold)
            env.probe(bronze)
        assert env.policy(gold)["status"] == "BREACH_PENDING"  # 93.0% < 99.9%
        assert env.policy(bronze)["status"] == "ACTIVE"  # 93.0% >= 90.0%
        assert 9300 <= env.policy(bronze)["uptime_bps"] <= 9310

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

    def test_confirmed_breach_pays_the_holder_a_vested_amount(self, funded):
        env = funded
        cov = 5 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        tvl_before = int(env.metrics()["tvl"])
        env.transfers.clear()
        r = env.settle(pid)
        p = env.policy(pid)
        expected = vested(cov, env.now - p["active_from"])
        assert r["paid"] and r["payout"] == str(expected)
        assert cov * 25 // 100 <= expected < cov * 30 // 100  # young policy: ~25% vested
        assert p["status"] == "PAID" and p["payout"] == str(expected)
        assert env.paid_to(env.bob) == expected
        assert env.paid_to(env.charlie) == PROBE_BOND  # settler's bond returned
        m = env.metrics()
        assert int(m["tvl"]) == tvl_before - expected
        assert m["total_payouts"] == str(expected)
        assert m["locked_coverage"] == "0" and m["reserved_payouts"] == "0" and m["active_policies"] == 0
        env.assert_solvent()

    def test_aged_policy_pays_full_coverage(self, funded):
        env = funded
        cov = 5 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.activate()
        env.advance(8 * 86400)
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=504)
        for _ in range(3):
            env.next_probe(pid)
        env.advance(GRACE + 1)
        assert env.settle(pid)["payout"] == str(cov)
        assert env.paid_to(env.bob) == cov

    def test_payout_goes_to_the_holder_whoever_settles(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.transfers.clear()
        env.settle(pid, who=env.alice)  # a stranger settles
        assert env.paid_to(env.alice) == PROBE_BOND  # only their own bond back
        assert env.paid_to(env.bob) > PROBE_BOND

    def test_settled_claim_cannot_be_settled_again(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.settle(pid)
        paid = env.paid_to(env.bob)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)
        assert env.paid_to(env.bob) == paid

    def test_recovered_endpoint_dismisses_the_claim(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.rpc(900)  # node came back during the grace period
        tvl = int(env.metrics()["tvl"])
        env.transfers.clear()
        r = env.settle(pid)
        assert not r["paid"]
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and p["consecutive_failures"] == 0
        m = env.metrics()
        assert m["reserved_payouts"] == "0" and m["locked_coverage"] == str(5 * ATTO)
        assert int(m["tvl"]) == tvl + PROBE_BOND  # unproductive settle bond forfeited
        assert env.paid_to(env.bob) == 0
        env.assert_solvent()

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
        env.rpc(900)
        env.settle(pid)  # dismissed
        env.rpc(status=502)
        for _ in range(3):
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
        env.withdraw(env.owner, tvl - 10 * ATTO)  # the reserved 10 stays


# ============================================================================
# Operator-collusion resistance
# ============================================================================
class TestCollusion:
    def test_cover_bought_on_an_already_dead_node_never_pays(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.down()
        for _ in range(12):
            env.next_probe(pid)
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and not p["baseline_ok"] and p["consecutive_failures"] == 12
        assert env.metrics()["reserved_payouts"] == "0"

    def test_no_instant_claim_after_purchase(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.down()
        with env.vm.expect_revert("[TOO_SOON]"):
            env.probe(pid)

    def test_self_dealing_on_a_fresh_policy_loses_most_of_the_cover(self, funded):
        env = funded
        cov = 10 * ATTO
        pid = env.create(env.bob, coverage=cov)
        env.stage_breach(pid)
        env.advance(GRACE + 1)
        env.settle(pid, who=env.bob)  # the operator settles their own claim
        assert env.policy(pid)["status"] == "PAID"
        assert int(env.policy(pid)["payout"]) < cov * 30 // 100

    def test_one_operator_cannot_concentrate_the_pool(self, funded):
        env = funded
        a = env.distinct_holders(1)[0]
        env.create(a, url="https://rpc.n1-node.io", coverage=10 * ATTO)
        env.create(a, url="https://rpc.n2-node.io", coverage=10 * ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(a, url="https://rpc.n3-node.io", coverage=10 * ATTO)

    def test_single_policy_loss_is_bounded_by_pool_share(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO)
        env.activate()
        env.advance(8 * 86400)
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        for _ in range(3):
            env.next_probe(pid)
        before = int(env.metrics()["tvl"])
        env.advance(GRACE + 1)
        env.settle(pid)
        assert int(env.metrics()["tvl"]) >= before - 10 * ATTO
        assert int(env.metrics()["tvl"]) >= 90 * ATTO  # <= 10% of the original pool lost


# ============================================================================
# Pool solvency invariants
# ============================================================================
class TestInvariants:
    @pytest.mark.parametrize("age_days", [0, 8])
    def test_solvency_under_simultaneous_breach_of_every_policy(self, funded, age_days):
        env = funded
        holders = env.distinct_holders(4)
        pids = []
        for i in range(8):  # 8 x 10 GEN = the 80% utilization ceiling
            pids.append(env.create(holders[i // 2], url=f"https://rpc.apex{i // 2}.io", coverage=10 * ATTO))
        env.assert_solvent()
        locked = int(env.metrics()["locked_coverage"])
        assert locked == 80 * ATTO

        env.activate()
        env.advance(age_days * 86400)
        env.rpc(100)
        for pid in pids:
            assert env.probe(pid)["ok"]
        env.rpc(status=502)
        for _ in range(3):
            env.advance(61)
            for pid in pids:
                env.probe(pid)
        assert all(env.policy(pid)["status"] == "BREACH_PENDING" for pid in pids)
        m = env.metrics()
        assert m["reserved_payouts"] == m["locked_coverage"] == str(80 * ATTO)
        env.assert_solvent()

        env.advance(GRACE + 1)
        paid = 0
        epochs = 0
        for pid in pids:
            while True:
                try:
                    paid += int(env.settle(pid)["payout"])
                    break
                except Exception as exc:  # claim velocity ceiling: the claim waits for the next epoch
                    assert "[VELOCITY_LIMIT]" in str(exc)
                    env.advance(86_400 + 1)
                    epochs += 1
            env.assert_solvent()
            assert int(env.metrics()["tvl"]) >= 0
        assert (epochs >= 2) if age_days else (epochs == 0)  # 8 x 10 GEN against a shrinking 30% ceiling needs several epochs
        m = env.metrics()
        assert m["locked_coverage"] == "0" and m["reserved_payouts"] == "0" and m["active_policies"] == 0
        assert m["total_payouts"] == str(paid)
        if age_days:
            assert paid == 80 * ATTO  # fully vested: every claim pays 100%
        else:
            assert paid < 80 * ATTO * 30 // 100
        # accounting identity: assets = deposits + premiums + forfeits - payouts
        assert int(m["tvl"]) == 100 * ATTO + int(m["total_premiums"]) + int(m["total_bond_forfeits"]) - paid
        # the pool was never asked for more than it held
        assert int(m["tvl"]) >= 100 * ATTO - 80 * ATTO

    def test_payout_never_exceeds_policy_coverage_or_pool(self, funded):
        env = funded
        pid = env.create(env.bob, coverage=10 * ATTO, blocks=300_000)  # ~42 days
        env.activate()
        env.advance(30 * 86400)
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        for _ in range(3):
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
        env.rpc(100)
        env.probe(env.contract.get_policy_count())  # healthy: bond forfeit adds yield
        assert int(env.metrics()["share_price"]) >= last

    def test_unauthorized_actions_rejected(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.rpc(100)
        env.probe(pid)
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.settle(pid)  # nothing staged: no payout possible
        with env.vm.expect_revert("[INVALID_STATE]"):
            env.contract.expire_policy(pid)  # cannot cut a live policy short
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.bob, 1)  # policyholders have no underwriting position
        assert env.metrics()["total_payouts"] == "0"

    def test_pool_metrics_shape(self, funded):
        env = funded
        m = env.metrics()
        for k in ("tvl", "utilization_bps", "apy_bps", "free_liquidity", "locked_coverage",
                  "reserved_payouts", "share_price", "active_policies", "solvent"):
            assert k in m
        assert m["solvent"] is True and m["utilization_bps"] == 0


# ============================================================================
# Hardening: Byzantine leader, LP early-exit, apex-domain caps, claim velocity
# ============================================================================
def honest(block: int) -> dict:
    return {"ok": True, "reason": "OK", "status": 200, "latency_ms": 20, "block": block}


class TestByzantineLeader:
    @pytest.fixture
    def probed(self, funded):
        env = funded
        pid = env.create(env.bob)
        env.activate()
        env.rpc(1_000)
        assert env.probe(pid)["block"] == 1_000
        return env, pid

    @pytest.mark.parametrize(
        "block,expected",
        [(1_000, True), (1_002, True), (1_003, False), (1_010, False), (990, True), (989, False)],
    )
    def test_leader_may_trail_by_ten_but_lead_by_at_most_two(self, probed, block, expected):
        env, _ = probed
        assert env.vm.run_validator(leader_result=honest(block)) is expected

    @pytest.mark.parametrize("block", [-5, -2, 0, 10**18, 2**53 + 1, 10**30])
    def test_negative_zero_and_absurd_heights_are_rejected(self, probed, block):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=honest(block))

    @pytest.mark.parametrize("block", ["1000", 1000.0, True, None])
    def test_non_integer_heights_are_rejected(self, probed, block):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=honest(block))

    def test_poisoned_high_block_is_rejected_even_when_the_verdict_matches(self, probed):
        """A leader reporting height 10**9 on a healthy endpoint agrees on 'ok' but must not be accepted."""
        env, _ = probed
        assert not env.vm.run_validator(leader_result=honest(10**9))

    def test_poisoned_low_block_cannot_manufacture_a_stale_verdict_later(self, probed):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=honest(5))

    def test_validator_measures_its_own_height(self, probed):
        env, _ = probed
        env.rpc(1_005)  # the validator's vantage point is a few blocks ahead: still honest
        assert env.vm.run_validator(leader_result=honest(1_000))
        env.rpc(1_100)  # but not 100 blocks ahead
        assert not env.vm.run_validator(leader_result=honest(1_000))
        env.rpc(990)  # a leader 10 ahead of the validator's view is a poisoning attempt
        assert not env.vm.run_validator(leader_result=honest(1_000))

    def test_ok_in_rpc_mode_requires_a_height(self, probed):
        env, _ = probed
        assert not env.vm.run_validator(leader_result=honest(-1))

    def test_failing_leader_cannot_smuggle_an_uncorroborated_height(self, probed):
        """HIGH_LATENCY results store `last_block`; if the validator sees no height at all, refuse."""
        env, _ = probed
        env.rpc(status=502)
        forged = {"ok": False, "reason": "HIGH_LATENCY", "status": 200, "latency_ms": 9_000, "block": 5_000_000}
        assert not env.vm.run_validator(leader_result=forged)

    def test_failing_leader_without_a_height_is_still_accepted(self, probed):
        env, _ = probed
        env.rpc(status=502)
        failing = {"ok": False, "reason": "HTTP_ERROR", "status": 502, "latency_ms": 10, "block": -1}
        assert env.vm.run_validator(leader_result=failing)

    def test_http_mode_has_no_height_requirement(self, funded):
        env = funded
        pid = env.create(env.bob, mode="http")
        env.activate()
        env.http(200)
        env.probe(pid)
        assert env.vm.run_validator(leader_result={"ok": True, "reason": "OK", "status": 200, "latency_ms": 5, "block": -1})


class TestUnderwriterEarlyExit:
    def _two_lps_with_pending_claim(self, env):
        env.deposit(env.alice, 50 * ATTO)
        env.deposit(env.owner, 50 * ATTO)
        pid = env.create(env.bob, coverage=10 * ATTO, blocks=100_000)
        env.activate()
        env.advance(8 * 86_400)  # fully vested: the claim will pay 100% of coverage
        env.rpc(100)
        env.probe(pid)
        env.rpc(status=502)
        for _ in range(3):
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
        alice_before = env.metrics()
        env.transfers.clear()
        value = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        env.withdraw(env.alice, value)  # Alice front-runs the settlement
        exit_amount = env.paid_to(env.alice)
        # Without net pricing Alice would walk away with ~half of gross TVL (~50 GEN).
        assert exit_amount < int(alice_before["tvl"]) // 2 - 4 * ATTO
        env.advance(GRACE + 1)
        assert env.settle(pid)["payout"] == str(10 * ATTO)
        owner_value = int(env.contract.get_underwriter(env.hex(env.owner))["value"])
        # Both LPs bore the loss equally: the stayer holds what the leaver was paid.
        assert abs(owner_value - exit_amount) <= 10**9, (owner_value, exit_amount)
        env.assert_solvent()

    def test_staying_lps_do_not_lose_more_than_their_share(self, env):
        """Counterfactual: if neither LP exits, each ends with the same value as the early exiter was paid."""
        pid = self._two_lps_with_pending_claim(env)
        before = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        env.advance(GRACE + 1)
        env.settle(pid)
        after = int(env.contract.get_underwriter(env.hex(env.alice))["value"])
        assert abs(after - before) <= 10**9

    def test_withdrawal_cannot_infringe_reserved_capital(self, env):
        self._two_lps_with_pending_claim(env)
        tvl = int(env.metrics()["tvl"])
        with env.vm.expect_revert("[INSUFFICIENT_LIQUIDITY]"):
            env.withdraw(env.owner, tvl - 9 * ATTO)  # more than the net position value
        free = int(env.metrics()["free_liquidity"])
        assert free == tvl - 10 * ATTO

    def test_deposits_are_frozen_while_a_claim_is_reserved(self, env):
        self._two_lps_with_pending_claim(env)
        assert int(env.metrics()["reserved_payouts"]) > 0
        shares_before = env.metrics()["total_shares"]
        with env.vm.expect_revert("[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"):
            env.deposit(env.charlie, 10 * ATTO)
        assert env.metrics()["total_shares"] == shares_before  # nothing was minted

    def test_deposits_reopen_at_the_gross_price_once_the_claim_settles(self, env):
        pid = self._two_lps_with_pending_claim(env)
        env.advance(GRACE + 1)
        env.settle(pid)  # paid in full
        m = env.metrics()
        assert m["reserved_payouts"] == "0" and m["net_assets"] == m["tvl"]
        minted = int(env.deposit(env.charlie, 10 * ATTO))
        assert minted == 10 * ATTO * int(m["total_shares"]) // int(m["tvl"])

    def test_reviewer_poc_staging_a_breach_cannot_buy_discounted_shares(self, env):
        """Stage a claim, try to buy cheap LP shares, let the claim be dismissed: no risk-free profit and no dilution."""
        pid = self._two_lps_with_pending_claim(env)
        before = {w: int(env.contract.get_underwriter(env.hex(w))["value"]) for w in (env.alice, env.owner)}
        # the attacker's discounted-entry attempt is rejected outright
        with env.vm.expect_revert("[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"):
            env.deposit(env.charlie, 50 * ATTO)
        # the claim is dismissed (the endpoint recovered during the grace period)
        env.advance(GRACE + 1)
        env.rpc(500)
        assert env.settle(pid)["paid"] is False
        after = {w: int(env.contract.get_underwriter(env.hex(w))["value"]) for w in (env.alice, env.owner)}
        assert env.metrics()["total_shares"] == str(100 * ATTO)  # no shares were ever minted to the attacker
        for w in before:
            assert after[w] >= before[w]  # existing LPs are never diluted: their value only rises
        # deposits are open again, at the gross (== net) price
        m = env.metrics()
        assert env.deposit(env.charlie, 10 * ATTO) == str(10 * ATTO * int(m["total_shares"]) // int(m["tvl"]))

    def test_a_dismissed_claim_returns_the_reserved_value_to_everyone(self, env):
        pid = self._two_lps_with_pending_claim(env)
        gross = int(env.metrics()["tvl"])
        env.advance(GRACE + 1)
        env.rpc(500)
        assert env.settle(pid)["paid"] is False
        m = env.metrics()
        assert int(m["net_assets"]) == int(m["tvl"]) and int(m["tvl"]) > gross


class TestApexDomainCaps:
    def test_subdomain_cycling_cannot_bypass_the_host_cap(self, funded):
        env = funded
        a, b, c = env.distinct_holders(3)
        env.create(a, url="https://rpc1.node.io", coverage=10 * ATTO)
        env.create(b, url="https://rpc2.node.io", coverage=10 * ATTO)  # apex node.io now at 20%
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, url="https://rpc3.node.io", coverage=ATTO)
        with env.vm.expect_revert("[EXPOSURE_CAP]"):
            env.create(c, url="https://a.b.c.node.io", coverage=ATTO)
        env.create(c, url="https://rpc.other-node.io", coverage=ATTO)  # a different registrable domain is fine

    @pytest.mark.parametrize(
        "host,apex",
        [
            ("rpc.node.io", "node.io"), ("a.b.c.node.io", "node.io"), ("node.io", "node.io"),
            ("rpc.example.co.uk", "example.co.uk"), ("example.co.uk", "example.co.uk"), ("a.b.example.com.au", "example.com.au"),
            ("my-node.vercel.app", "my-node.vercel.app"), ("x.my-node.vercel.app", "my-node.vercel.app"),
            ("tenant.github.io", "tenant.github.io"), ("8.8.8.8", "8.8.8.8"),
        ],
    )
    def test_apex_extraction(self, funded, host, apex):
        env = funded
        pid = env.create(env.bob, url=f"https://{host}", coverage=ATTO)
        assert env.policy(pid)["apex"] == apex

    def test_platform_tenants_do_not_share_a_cap(self, funded):
        env = funded
        a, b, c = env.distinct_holders(3)
        env.create(a, url="https://one.vercel.app", coverage=10 * ATTO)
        env.create(b, url="https://two.vercel.app", coverage=10 * ATTO)
        env.create(c, url="https://three.vercel.app", coverage=10 * ATTO)  # separate tenants, separate apex

    def test_apex_exposure_is_released_on_close(self, funded):
        env = funded
        a, b = env.distinct_holders(2)
        pid = env.create(a, url="https://rpc1.node.io", coverage=10 * ATTO, blocks=300)
        env.create(b, url="https://rpc2.node.io", coverage=10 * ATTO)
        env.advance(ACTIVATION + 300 * 12)
        env.contract.expire_policy(pid)
        env.create(a, url="https://rpc3.node.io", coverage=10 * ATTO)  # room again


class TestClaimVelocity:
    def _breach_all(self, env, n):
        holders = env.distinct_holders(4)
        pids = [env.create(holders[i // 2], url=f"https://rpc.apex{i // 2}.io", coverage=10 * ATTO) for i in range(n)]
        env.activate()
        env.advance(8 * 86_400)
        env.rpc(100)
        for pid in pids:
            env.probe(pid)
        env.rpc(status=502)
        for _ in range(3):
            env.advance(61)
            for pid in pids:
                env.probe(pid)
        env.advance(GRACE + 1)
        return pids

    def test_payouts_beyond_the_epoch_ceiling_wait_for_the_next_epoch(self, funded):
        env = funded
        pids = self._breach_all(env, 6)
        ceiling = int(env.metrics()["epoch_ceiling"])
        assert ceiling == int(env.metrics()["tvl"]) * 3000 // 10_000
        for pid in pids[:3]:
            assert env.settle(pid)["paid"]
        assert int(env.metrics()["epoch_paid"]) == 30 * ATTO
        before = env.metrics()
        with env.vm.expect_revert("[VELOCITY_LIMIT]"):
            env.settle(pids[3])
        # a rejected settlement changes nothing: the claim is still staged and reserved
        after = env.metrics()
        assert env.policy(pids[3])["status"] == "BREACH_PENDING"
        assert (after["tvl"], after["reserved_payouts"], after["total_probes"]) == (before["tvl"], before["reserved_payouts"], before["total_probes"])
        env.advance(86_400 + 1)
        assert int(env.metrics()["epoch_paid"]) == 0  # the new epoch starts clean
        # the ceiling is 30% of the (now smaller) pool: two more claims fit, the sixth waits again
        assert env.settle(pids[3])["paid"] and env.settle(pids[4])["paid"]
        with env.vm.expect_revert("[VELOCITY_LIMIT]"):
            env.settle(pids[5])
        env.advance(86_400 + 1)
        assert env.settle(pids[5])["paid"]
        env.assert_solvent()

    def test_a_single_step_can_never_pay_more_than_the_ceiling(self, funded):
        env = funded
        pids = self._breach_all(env, 8)
        tvl_before = int(env.metrics()["tvl"])
        paid = 0
        for pid in pids:
            try:
                paid += int(env.settle(pid)["payout"])
            except Exception as exc:
                assert "[VELOCITY_LIMIT]" in str(exc)
        assert paid == 30 * ATTO
        assert paid <= tvl_before * 3000 // 10_000
        assert int(env.metrics()["tvl"]) == tvl_before - paid

    def test_dismissals_are_not_rate_limited(self, funded):
        env = funded
        pids = self._breach_all(env, 8)
        env.rpc(500)  # everything recovered during the grace period
        for pid in pids:
            assert env.settle(pid)["paid"] is False
        assert env.metrics()["epoch_paid"] == "0"

    def test_every_claim_is_eventually_paid_inside_the_settlement_window(self, funded):
        """The ceiling shrinks with the pool, so it can fall below a single claim; the
        first payout of each epoch is always allowed so the queue still drains."""
        env = funded
        pids = self._breach_all(env, 8)
        ceilings, days = [], 0
        while any(env.policy(pid)["status"] == "BREACH_PENDING" for pid in pids):
            ceilings.append(int(env.metrics()["epoch_ceiling"]))
            for pid in pids:
                if env.policy(pid)["status"] == "BREACH_PENDING":
                    try:
                        env.settle(pid)
                    except Exception as exc:
                        assert "[VELOCITY_LIMIT]" in str(exc)
            env.advance(86_400 + 1)
            days += 1
            assert days <= 10, "queue failed to drain"
        assert all(env.policy(pid)["status"] == "PAID" for pid in pids)
        assert min(ceilings) < 10 * ATTO  # the progress guarantee was actually exercised
        assert days <= 7  # well inside the 14-day settlement window
        env.assert_solvent()


class TestStaleBlockPoisoning:
    """A Byzantine leader must not be able to fabricate three consecutive STALE_BLOCK verdicts on a slow chain."""

    def test_a_leader_ten_blocks_ahead_is_rejected_so_it_cannot_poison_last_block(self, funded):
        env = funded
        pid = env.create(env.bob, interval=5)
        env.activate()
        env.rpc(2_000)
        env.probe(pid)  # honest probe stores last_block = 2000
        assert env.policy(pid)["last_block"] == 2_000
        # the next healthy probe: a leader claiming real+10 is refused by every validator that sees real
        env.advance(61)
        env.rpc(2_005)
        assert env.probe(pid)["ok"]
        assert not env.vm.run_validator(leader_result=honest(2_015))
        assert env.vm.run_validator(leader_result=honest(2_005))
        assert env.vm.run_validator(leader_result=honest(2_007))  # +2 is the slack for load-balanced nodes
        assert not env.vm.run_validator(leader_result=honest(2_008))

    def test_slow_progression_never_yields_consecutive_stale_verdicts(self, funded):
        """Even at the most the validators will accept (+2 over the true height), a chain that advances
        5 blocks per probe is never judged stale, so no breach can be staged."""
        env = funded
        pid = env.create(env.bob, interval=5)
        env.activate()
        real = 3_000
        for _ in range(8):
            real += 5
            env.rpc(real)
            r = env.next_probe(pid)
            assert r["ok"], r
            assert env.policy(pid)["last_block"] <= real
        p = env.policy(pid)
        assert p["status"] == "ACTIVE" and p["consecutive_failures"] == 0

    def test_a_genuinely_frozen_node_is_still_detected(self, funded):
        env = funded
        pid = env.create(env.bob, interval=5)
        env.activate()
        env.rpc(5_000)
        env.probe(pid)
        for _ in range(3):
            assert env.next_probe(pid)["reason"] == "STALE_BLOCK"  # height never moves
        assert env.policy(pid)["status"] == "BREACH_PENDING"
