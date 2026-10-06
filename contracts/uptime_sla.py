# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# PulseSLA -- Parametric SLA & Infrastructure Downtime Insurance Protocol.
#
# Underwriters pool native GEN and earn premiums; infrastructure teams buy
# parametric policies on an HTTP / JSON-RPC endpoint; anyone may trigger a
# health probe by posting a small bond. A probe is a non-deterministic web
# round: the leader measures the endpoint (HTTP status, latency, block
# freshness) and every validator re-measures it independently. The VERDICT
# (healthy / failing) must agree; raw latency and block height never have to.
# When failures cross the policy's SLA thresholds a claim is staged, survives a
# grace period, is re-verified by a second consensus round, and only then pays.
#
# Anti-collusion (an operator insuring its own node and pulling it down):
#   * activation delay      -- a policy cannot be probed or claimed immediately;
#   * healthy-baseline rule -- cover only exists once the endpoint was seen
#                              healthy, so buying cover on a dead node pays 0;
#   * staged claims         -- N consecutive failing probes, then a grace period,
#                              then a fresh consensus re-verification;
#   * payout vesting ramp   -- a young policy pays only a fraction of coverage;
#   * exposure caps         -- per policy, per endpoint host, per holder and in
#                              total, all relative to the pool's locked depth.
#
# Solvency invariant (checked by every test): locked_coverage <= pool_assets.
# Coverage is locked at policy creation, so a payout (always <= coverage) lowers
# pool_assets and locked_coverage together and can never overdraw the pool.

import ipaddress
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import genlayer as gl
from genlayer import Address, u256
from genlayer.storage import DynArray, TreeMap

# genvm-lint matches the bare name `allow_storage` (see E014 note in the
# reference project); bind it to the SDK's own decorator.
allow_storage = gl.storage.allow

# --- Error classification ---------------------------------------------------
ERR_EXPECTED = "[EXPECTED]"  # deterministic business-rule rejection
ERR_UNAUTHORIZED = "[UNAUTHORIZED]"
ERR_PARAMS = "[INVALID_PARAMS]"
ERR_LIQUIDITY = "[INSUFFICIENT_LIQUIDITY]"
ERR_CAP = "[EXPOSURE_CAP]"
ERR_STATE = "[INVALID_STATE]"
ERR_TOO_SOON = "[TOO_SOON]"

# --- Policy lifecycle -------------------------------------------------------
ST_ACTIVE = "ACTIVE"
ST_BREACH_PENDING = "BREACH_PENDING"  # claim staged; payout reserved
ST_PAID = "PAID"
ST_EXPIRED = "EXPIRED"
ST_LAPSED = "LAPSED"  # claim not settled inside the settlement window

# --- Probe verdict reasons --------------------------------------------------
R_OK = "OK"
R_HTTP_ERROR = "HTTP_ERROR"
R_UNREACHABLE = "UNREACHABLE"
R_HIGH_LATENCY = "HIGH_LATENCY"
R_STALE_BLOCK = "STALE_BLOCK"
R_BAD_PAYLOAD = "BAD_PAYLOAD"

MODE_RPC = "rpc"  # POST eth_blockNumber: status + latency + block freshness
MODE_HTTP = "http"  # GET: status + latency only
VALID_MODES = (MODE_RPC, MODE_HTTP)

# --- Economics (atto-scale: value * 10 ** 18) -------------------------------
ATTO = 10**18
MIN_DEPOSIT = 10**15
MIN_COVERAGE = 10**15
BPS = 10000
YEAR_SECS = 365 * 24 * 3600
BLOCK_SECONDS = 12  # policy durations / intervals are quoted in 12s blocks

# Annualised premium rate by SLA tier (bps of coverage per year).
RATE_GOLD_BPS = 800  # min_uptime >= 99.90%
RATE_SILVER_BPS = 400  # min_uptime >= 99.00%
RATE_BRONZE_BPS = 200
TIER_GOLD_UPTIME = 9990
TIER_SILVER_UPTIME = 9900
MIN_PREMIUM_BPS = 10  # premium floor: 0.10% of coverage

# --- Exposure caps (bps of pool_assets) -------------------------------------
MAX_POLICY_BPS = 1000  # one policy <= 10% of the pool
MAX_HOST_BPS = 2000  # all policies on one endpoint host <= 20%
MAX_HOLDER_BPS = 2000  # all policies of one holder <= 20%
MAX_UTILIZATION_BPS = 8000  # locked coverage <= 80% of the pool

# --- Policy parameter bounds -------------------------------------------------
MIN_LATENCY_MS = 50
MAX_LATENCY_MS = 30000
MIN_UPTIME_BPS = 9000
MAX_UPTIME_BPS = 9999
MIN_DURATION_BLOCKS = 300  # ~1 hour
MAX_DURATION_BLOCKS = 2_628_000  # ~1 year
MIN_INTERVAL_BLOCKS = 5  # ~1 minute
MAX_INTERVAL_BLOCKS = 7200  # ~1 day

# --- Staged claim parameters -------------------------------------------------
BREACH_CONSECUTIVE = 3  # consecutive failing probes needed to stage a claim
MEASUREMENT_WINDOW = 30 * 24 * 3600  # uptime sample window (30 days)
SETTLE_WINDOW = 14 * 24 * 3600  # after settle_at, a claim lapses (outlasts the velocity queue)
PAYOUT_FLOOR_BPS = 2500  # a brand-new policy vests 25% of coverage ...
PAYOUT_RAMP_SECS = 7 * 24 * 3600  # ... rising linearly to 100% over 7 days
MIN_STALE_ELAPSED = 60  # block must advance if >= this many seconds passed
LATENCY_TOLERANCE_BPS = 2000  # validators accept latency verdicts +-20% of limit

# Rogue-leader bounds (see _verdicts_agree): independent observations of one
# chain can differ by a few blocks, never by more than this.
MAX_BLOCK_DRIFT = 10
MAX_BLOCK_HEIGHT = 2**53  # beyond any real chain; rejects absurd leader values

# Claim velocity: payouts per epoch are capped at a share of pool assets, so a
# wave of simultaneous breaches is paid out over several epochs, not in one step.
EPOCH_SECONDS = 24 * 3600
MAX_EPOCH_PAYOUT_BPS = 3000  # 30% of pool assets per epoch
ERR_VELOCITY = "[VELOCITY_LIMIT]"

# Multi-label public suffixes, so that exposure is grouped by registrable domain
# (eTLD+1) rather than by subdomain. A full Public Suffix List cannot be embedded
# in a contract; this covers common country-code and hosting-platform suffixes.
# Anything else falls back to the last two labels.
_MULTI_LABEL_SUFFIXES = (
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "or.jp",
    "co.kr", "co.in", "net.in", "com.br", "com.cn", "com.hk", "com.sg", "com.tw", "com.tr", "com.mx",
    "com.ar", "co.za", "co.il", "com.ua", "com.pl",
    "vercel.app", "netlify.app", "github.io", "gitlab.io", "pages.dev", "workers.dev", "web.app",
    "firebaseapp.com", "herokuapp.com", "onrender.com", "fly.dev", "railway.app", "azurewebsites.net",
    "cloudfront.net", "amazonaws.com", "elasticbeanstalk.com", "appspot.com", "ngrok.io", "ngrok-free.app",
)

_BLOCKED_SUFFIXES = (
    ".local",
    ".localhost",
    ".internal",
    ".lan",
    ".home",
    ".nip.io",
    ".sslip.io",
    ".xip.io",
)
_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")


# ---------------------------------------------------------------------------
# Pure helpers (no storage access: safe to call inside non-deterministic blocks)
# ---------------------------------------------------------------------------
def _hex(addr: Address) -> str:
    """Canonical lowercase address key (as_hex is EIP-55 mixed case)."""
    return addr.as_hex.lower()


def _hostname(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except (ValueError, TypeError):
        return ""
    return (parts.hostname or "").lower().rstrip(".")


def _is_safe_endpoint(url: str) -> bool:
    """Deterministic SSRF guard: http(s) only, no credentials / backslashes,
    no loopback / private / link-local / reserved addresses, no numeric-host
    encodings (hex, decimal, octal) and no internal-only suffixes."""
    if "\\" in url or len(url) > 512 or url != url.strip():
        return False
    low = url.lower()
    if not (low.startswith("https://") or low.startswith("http://")):
        return False
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 -- raises ValueError on a malformed port
    except ValueError:
        return False
    if parts.username is not None or parts.password is not None:
        return False
    host = _hostname(url)
    if host == "" or ":" in host:  # empty or IPv6 literal
        return False
    labels = host.split(".")
    if all(p.isdigit() for p in labels):  # dotted-quad candidate
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            return False
        return bool(ip.is_global)
    if len(labels) < 2 or not all(_LABEL_RE.match(p) for p in labels):
        return False
    tld = labels[-1]
    if not tld.isalpha() or len(tld) < 2:  # kills 0x7f000001-style hosts
        return False
    if host == "localhost":
        return False
    for suffix in _BLOCKED_SUFFIXES:
        if host.endswith(suffix):
            return False
    return True


def _apex(host: str) -> str:
    """Registrable domain (eTLD+1) of a hostname, used to group exposure so that
    cycling subdomains (a.node.io, b.node.io, ...) cannot bypass the per-host cap.
    IP literals are returned unchanged."""
    labels = host.split(".")
    if len(labels) <= 2 or all(p.isdigit() for p in labels):
        return host
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_LABEL_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return last_two


def _tier_rate_bps(min_uptime_bps: int) -> int:
    if min_uptime_bps >= TIER_GOLD_UPTIME:
        return RATE_GOLD_BPS
    if min_uptime_bps >= TIER_SILVER_UPTIME:
        return RATE_SILVER_BPS
    return RATE_BRONZE_BPS


def _premium_for(coverage: int, duration_blocks: int, min_uptime_bps: int) -> int:
    secs = duration_blocks * BLOCK_SECONDS
    premium = coverage * _tier_rate_bps(min_uptime_bps) * secs // (BPS * YEAR_SECS)
    floor = coverage * MIN_PREMIUM_BPS // BPS
    return premium if premium > floor else floor


def _vested_payout(coverage: int, age_secs: int) -> int:
    """Payout vests linearly from PAYOUT_FLOOR_BPS to 100% of coverage over
    PAYOUT_RAMP_SECS of policy age -- the anti-collusion staging curve."""
    age = age_secs if age_secs > 0 else 0
    if age >= PAYOUT_RAMP_SECS:
        return coverage
    bps = PAYOUT_FLOOR_BPS + (BPS - PAYOUT_FLOOR_BPS) * age // PAYOUT_RAMP_SECS
    return coverage * bps // BPS


def _clock_us() -> int:
    """Best-effort microsecond clock for latency.

    KNOWN LIMITATION (verified on Studio Next): neither `time.perf_counter()` nor
    `gl.vm.trace_time_micro()` advances across a web request inside GenVM, so the
    measured latency is 0 ms on-chain. HTTP status, payload validity and block
    freshness are enforced; the latency threshold only bites where the clock
    works (the direct-test harness). `gl.vm.get_timestamp()` has one-second
    resolution, too coarse to enforce millisecond limits without false breaches."""
    try:
        t = gl.vm.trace_time_micro()
        if isinstance(t, int) and t > 0:
            return t
    except Exception:
        pass
    return int(time.perf_counter() * 1_000_000)


def _measure(url: str, mode: str, max_latency_ms: int, last_block: int, elapsed: int) -> dict:
    """One health observation. Runs inside the non-deterministic block on the
    leader AND on every validator. Never raises: an endpoint that cannot be
    reached IS the observation. Returns a calldata-safe dict."""
    reachable = True
    status = 0
    body_text = ""
    started = _clock_us()
    try:
        if mode == MODE_RPC:
            res = gl.nondet.web.post(
                url,
                body=json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
        else:
            res = gl.nondet.web.get(url)
        status = int(getattr(res, "status", 0) or 0)
        raw = getattr(res, "body", None)
        if isinstance(raw, (bytes, bytearray)):
            body_text = bytes(raw).decode("utf-8", errors="replace")
        elif isinstance(raw, str):
            body_text = raw
    except Exception:
        reachable = False
    latency_ms = max(0, (_clock_us() - started) // 1000)

    block = -1
    payload_ok = True
    if mode == MODE_RPC and reachable and status == 200:
        payload_ok = False
        try:
            data = json.loads(body_text)
            result = data.get("result") if isinstance(data, dict) else None
            if isinstance(result, str) and result.startswith("0x") and len(result) > 2:
                block = int(result, 16)
                payload_ok = block >= 0
        except Exception:
            payload_ok = False

    if not reachable:
        reason = R_UNREACHABLE
    elif status != 200:
        reason = R_HTTP_ERROR
    elif not payload_ok:
        reason = R_BAD_PAYLOAD
    elif latency_ms > max_latency_ms:
        reason = R_HIGH_LATENCY
    elif mode == MODE_RPC and last_block > 0 and elapsed >= MIN_STALE_ELAPSED and block <= last_block:
        reason = R_STALE_BLOCK
    else:
        reason = R_OK

    return {
        "ok": reason == R_OK,
        "reason": reason,
        "status": status,
        "latency_ms": latency_ms,
        "block": block,
    }


def _verdicts_agree(leaders_res, leader_fn, max_latency_ms: int, rpc_mode: bool) -> bool:
    """Validator rule.

    1. The healthy/failing verdict must match (the failure CLASS need not).
    2. The leader's block height is bounded against this validator's OWN
       observation: |leader - validator| <= MAX_BLOCK_DRIFT. A Byzantine leader
       therefore cannot poison the stored `last_block` (and so induce, or hide,
       STALE_BLOCK verdicts) beyond that drift. Negative, zero-on-success or
       absurd heights are rejected outright.
    3. A verdict split that is purely a latency call within +-20% of the limit is
       tolerated, because latency jitter between vantage points is not a lie."""
    if not isinstance(leaders_res, gl.vm.Return):
        return False
    lead = leaders_res.calldata
    if not isinstance(lead, dict):
        return False
    for key in ("ok", "reason", "status", "latency_ms", "block"):
        if key not in lead:
            return False
    if not isinstance(lead["ok"], bool):
        return False
    lead_block = lead["block"]
    if not isinstance(lead_block, int) or isinstance(lead_block, bool):
        return False
    if lead_block < -1 or lead_block == 0 or lead_block > MAX_BLOCK_HEIGHT:
        return False
    if lead["ok"] and lead["status"] != 200:
        return False
    if lead["ok"] and rpc_mode and lead_block < 0:
        return False
    mine = leader_fn()
    my_block = mine["block"]
    if lead_block > 0:
        if my_block > 0:
            if abs(lead_block - my_block) > MAX_BLOCK_DRIFT:
                return False
        elif lead["reason"] in (R_OK, R_HIGH_LATENCY):
            # The leader's height would be stored but this validator cannot
            # corroborate any height: refuse rather than accept it unchecked.
            return False
    if bool(lead["ok"]) == bool(mine["ok"]):
        return True
    if lead["reason"] in (R_OK, R_HIGH_LATENCY) and mine["reason"] in (R_OK, R_HIGH_LATENCY):
        lo = max_latency_ms * (BPS - LATENCY_TOLERANCE_BPS) // BPS
        hi = max_latency_ms * (BPS + LATENCY_TOLERANCE_BPS) // BPS
        return lo <= int(lead["latency_ms"]) <= hi and lo <= int(mine["latency_ms"]) <= hi
    return False


def _describe(obs: dict, max_latency_ms: int) -> str:
    reason = obs["reason"]
    if reason == R_OK:
        return f"healthy: HTTP 200 in {obs['latency_ms']}ms, block {obs['block']}"
    if reason == R_UNREACHABLE:
        return "endpoint unreachable (connection failed or timed out)"
    if reason == R_HTTP_ERROR:
        return f"HTTP {obs['status']} returned, SLA requires 200"
    if reason == R_BAD_PAYLOAD:
        return "eth_blockNumber returned an invalid or missing result"
    if reason == R_HIGH_LATENCY:
        return f"latency {obs['latency_ms']}ms exceeds limit {max_latency_ms}ms"
    return f"block height frozen at {obs['block']}: node is not advancing"


@allow_storage
@dataclass
class Policy:
    holder: Address
    endpoint_url: str
    host: str
    apex: str  # registrable domain (eTLD+1): the unit of the per-host exposure cap
    probe_mode: str
    max_latency_ms: u256
    min_uptime_bps: u256
    probe_interval: u256  # seconds
    coverage: u256
    premium: u256
    duration_secs: u256
    created_at: u256
    active_from: u256
    expires_at: u256
    status: str
    # --- probe statistics (current measurement window) ---
    window_started: u256
    samples_total: u256
    samples_ok: u256
    consecutive_failures: u256
    baseline_ok: bool  # endpoint has been observed healthy at least once
    last_probe_at: u256
    last_block: u256
    last_latency_ms: u256
    last_reason: str
    last_ok: bool
    # --- staged claim ---
    settle_at: u256
    claim_count: u256
    payout: u256


class PulseSLA(gl.contract.Contract):
    # Underwriting pool (share-based accounting).
    pool_assets: u256  # GEN owned by underwriters: deposits + premiums - payouts
    total_shares: u256
    shares: TreeMap[str, u256]  # underwriter hex -> shares
    # Exposure book.
    locked_coverage: u256  # coverage of every live policy (ACTIVE + BREACH_PENDING)
    reserved_payouts: u256  # subset of locked: coverage earmarked by confirmed breaches
    host_exposure: TreeMap[str, u256]
    holder_exposure: TreeMap[str, u256]
    # Policies.
    policies: TreeMap[u256, Policy]
    next_policy_id: u256
    active_policies: u256
    annual_premium_run_rate: u256  # sum of premium * YEAR / duration over live policies
    # Lifetime counters.
    total_premiums: u256
    total_payouts: u256
    total_bond_forfeits: u256
    total_probes: u256
    total_breaches: u256
    # Claim-velocity accounting (current epoch).
    velocity_epoch: u256
    velocity_paid: u256
    velocity_base: u256  # pool assets when the epoch's first payout was made
    # Immutable protocol parameters (set at deploy).
    activation_delay: u256
    claim_grace: u256
    probe_bond: u256
    # Append-only incident log: JSON strings (appended last to keep layout stable).
    incidents: DynArray[str]

    def __init__(self, activation_delay_secs: u256, claim_grace_secs: u256, probe_bond: u256):
        self.pool_assets = 0
        self.total_shares = 0
        self.locked_coverage = 0
        self.reserved_payouts = 0
        self.next_policy_id = 1
        self.active_policies = 0
        self.annual_premium_run_rate = 0
        self.total_premiums = 0
        self.total_payouts = 0
        self.total_bond_forfeits = 0
        self.total_probes = 0
        self.total_breaches = 0
        self.velocity_epoch = 0
        self.velocity_paid = 0
        self.velocity_base = 0
        self.activation_delay = activation_delay_secs
        self.claim_grace = claim_grace_secs
        self.probe_bond = probe_bond

    # ------------------------------------------------------------------ views
    @gl.public.view
    def get_pool_metrics(self) -> dict:
        assets = int(self.pool_assets)
        locked = int(self.locked_coverage)
        shares = int(self.total_shares)
        free = assets - locked if assets > locked else 0
        net = self._net_assets()
        epoch_paid, epoch_ceiling = self._velocity_window(self._now(), assets)
        return {
            "tvl": str(assets),
            "net_assets": str(net),
            "total_shares": str(shares),
            "share_price": str(net * ATTO // shares) if shares > 0 else str(ATTO),
            "epoch_paid": str(epoch_paid),
            "epoch_ceiling": str(epoch_ceiling),
            "max_epoch_payout_bps": MAX_EPOCH_PAYOUT_BPS,
            "locked_coverage": str(locked),
            "reserved_payouts": str(int(self.reserved_payouts)),
            "free_liquidity": str(free),
            "utilization_bps": (locked * BPS // assets) if assets > 0 else 0,
            "apy_bps": (int(self.annual_premium_run_rate) * BPS // assets) if assets > 0 else 0,
            "active_policies": int(self.active_policies),
            "total_policies": int(self.next_policy_id) - 1,
            "total_premiums": str(int(self.total_premiums)),
            "total_payouts": str(int(self.total_payouts)),
            "total_bond_forfeits": str(int(self.total_bond_forfeits)),
            "total_probes": int(self.total_probes),
            "total_breaches": int(self.total_breaches),
            "activation_delay": int(self.activation_delay),
            "claim_grace": int(self.claim_grace),
            "probe_bond": str(int(self.probe_bond)),
            "solvent": locked <= assets and int(self.reserved_payouts) <= locked,
        }

    @gl.public.view
    def get_underwriter(self, underwriter_hex: str) -> dict:
        underwriter_hex = underwriter_hex.lower()
        s = int(self.shares[underwriter_hex]) if underwriter_hex in self.shares else 0
        assets = int(self.pool_assets)
        shares = int(self.total_shares)
        value = s * self._net_assets() // shares if shares > 0 else 0
        locked = int(self.locked_coverage)
        free = assets - locked if assets > locked else 0
        return {
            "shares": str(s),
            "value": str(value),
            "withdrawable": str(value if value < free else free),
        }

    @gl.public.view
    def get_policy_count(self) -> int:
        return int(self.next_policy_id) - 1

    @gl.public.view
    def get_policy_status(self, policy_id: u256) -> dict:
        if policy_id not in self.policies:
            raise gl.vm.UserError(f"{ERR_STATE} unknown policy")
        return self._policy_dict(policy_id)

    @gl.public.view
    def list_policies(self, offset: u256, limit: u256) -> list:
        out = []
        last = int(self.next_policy_id)
        i = int(offset) + 1
        while i < last and len(out) < int(limit) and len(out) < 50:
            out.append(self._policy_dict(i))
            i += 1
        return out

    @gl.public.view
    def quote_premium(self, coverage_amount: u256, duration_blocks: u256, min_uptime_bps: u256) -> str:
        return str(_premium_for(int(coverage_amount), int(duration_blocks), int(min_uptime_bps)))

    @gl.public.view
    def get_incident_count(self) -> int:
        return len(self.incidents)

    @gl.public.view
    def get_incidents(self, offset: u256, limit: u256) -> list:
        out = []
        i = int(offset)
        n = len(self.incidents)
        while i < n and len(out) < int(limit) and len(out) < 100:
            out.append(self.incidents[i])
            i += 1
        return out

    @gl.public.view
    def whoami(self) -> str:
        return _hex(gl.message.sender_address)

    # ------------------------------------------------------------ underwriting
    @gl.public.write.payable
    def deposit_underwriting(self) -> str:
        amount = int(gl.message.value)
        if amount < MIN_DEPOSIT:
            raise gl.vm.UserError(f"{ERR_PARAMS} deposit below minimum")
        assets = int(self.pool_assets)
        net = self._net_assets()
        total = int(self.total_shares)
        if total == 0:
            minted = amount
        else:
            if net == 0:
                raise gl.vm.UserError(f"{ERR_STATE} pool has no unreserved assets; deposits closed")
            minted = amount * total // net  # priced on assets net of pending claims
        if minted == 0:
            raise gl.vm.UserError(f"{ERR_PARAMS} deposit too small for current share price")
        who = _hex(gl.message.sender_address)
        prev = int(self.shares[who]) if who in self.shares else 0
        self.shares[who] = prev + minted
        self.total_shares = total + minted
        self.pool_assets = assets + amount
        return str(minted)

    @gl.public.write
    def withdraw_underwriting(self, amount: u256) -> str:
        want = int(amount)
        if want <= 0:
            raise gl.vm.UserError(f"{ERR_PARAMS} amount must be positive")
        who = _hex(gl.message.sender_address)
        held = int(self.shares[who]) if who in self.shares else 0
        assets = int(self.pool_assets)
        net = self._net_assets()  # assets minus capital reserved for staged claims
        total = int(self.total_shares)
        if held == 0 or total == 0 or net == 0:
            raise gl.vm.UserError(f"{ERR_LIQUIDITY} no redeemable underwriting position")
        # Shares redeem at net asset value, so an LP who exits while a claim is
        # staged takes the pro-rata share of that pending loss with them instead
        # of leaving it to the LPs who stay.
        value = held * net // total
        if want > value:
            raise gl.vm.UserError(f"{ERR_LIQUIDITY} amount exceeds position value")
        locked = int(self.locked_coverage)
        free = assets - locked if assets > locked else 0
        if want > free:
            raise gl.vm.UserError(f"{ERR_LIQUIDITY} capital is locked behind active coverage")
        burn = (want * total + net - 1) // net  # ceil: never under-burn
        if burn > held:
            burn = held
        # effects before interaction
        self.shares[who] = held - burn
        self.total_shares = total - burn
        self.pool_assets = assets - want
        self._pay(gl.message.sender_address, want)
        return str(want)

    # -------------------------------------------------------------- policies
    @gl.public.write.payable
    def create_policy(
        self,
        endpoint_url: str,
        max_latency_ms: u256,
        coverage_amount: u256,
        duration_blocks: u256,
        min_uptime_bps: u256,
        probe_interval_blocks: u256,
        probe_mode: str,
    ) -> u256:
        if not _is_safe_endpoint(endpoint_url):
            raise gl.vm.UserError(f"{ERR_PARAMS} endpoint URL rejected (must be a public http(s) host)")
        lat = int(max_latency_ms)
        cov = int(coverage_amount)
        dur = int(duration_blocks)
        up = int(min_uptime_bps)
        interval = int(probe_interval_blocks)
        if not (MIN_LATENCY_MS <= lat <= MAX_LATENCY_MS):
            raise gl.vm.UserError(f"{ERR_PARAMS} max_latency_ms out of range")
        if cov < MIN_COVERAGE:
            raise gl.vm.UserError(f"{ERR_PARAMS} coverage below minimum")
        if not (MIN_DURATION_BLOCKS <= dur <= MAX_DURATION_BLOCKS):
            raise gl.vm.UserError(f"{ERR_PARAMS} duration out of range")
        if not (MIN_UPTIME_BPS <= up <= MAX_UPTIME_BPS):
            raise gl.vm.UserError(f"{ERR_PARAMS} min_uptime_bps out of range")
        if not (MIN_INTERVAL_BLOCKS <= interval <= MAX_INTERVAL_BLOCKS):
            raise gl.vm.UserError(f"{ERR_PARAMS} probe interval out of range")
        if probe_mode not in VALID_MODES:
            raise gl.vm.UserError(f"{ERR_PARAMS} probe_mode must be rpc or http")

        premium = _premium_for(cov, dur, up)
        paid = int(gl.message.value)
        if paid < premium:
            raise gl.vm.UserError(f"{ERR_EXPECTED} premium {premium} not covered by value {paid}")

        assets = int(self.pool_assets)
        locked = int(self.locked_coverage)
        host = _hostname(endpoint_url)
        apex = _apex(host)
        holder = gl.message.sender_address
        holder_hex = _hex(holder)
        host_now = int(self.host_exposure[apex]) if apex in self.host_exposure else 0
        holder_now = int(self.holder_exposure[holder_hex]) if holder_hex in self.holder_exposure else 0
        if cov > assets * MAX_POLICY_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} coverage exceeds per-policy cap of pool depth")
        if locked + cov > assets * MAX_UTILIZATION_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} pool utilization cap reached")
        if host_now + cov > assets * MAX_HOST_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} per-endpoint (registrable domain) exposure cap reached")
        if holder_now + cov > assets * MAX_HOLDER_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} per-holder exposure cap reached")

        now = self._now()
        duration_secs = dur * BLOCK_SECONDS
        pid = int(self.next_policy_id)
        self.next_policy_id = pid + 1
        self.policies[pid] = Policy(
            holder=holder,
            endpoint_url=endpoint_url,
            host=host,
            apex=apex,
            probe_mode=probe_mode,
            max_latency_ms=lat,
            min_uptime_bps=up,
            probe_interval=interval * BLOCK_SECONDS,
            coverage=cov,
            premium=premium,
            duration_secs=duration_secs,
            created_at=now,
            active_from=now + int(self.activation_delay),
            expires_at=now + int(self.activation_delay) + duration_secs,
            status=ST_ACTIVE,
            window_started=0,
            samples_total=0,
            samples_ok=0,
            consecutive_failures=0,
            baseline_ok=False,
            last_probe_at=0,
            last_block=0,
            last_latency_ms=0,
            last_reason="",
            last_ok=False,
            settle_at=0,
            claim_count=0,
            payout=0,
        )
        # effects
        self.locked_coverage = locked + cov
        self.host_exposure[apex] = host_now + cov
        self.holder_exposure[holder_hex] = holder_now + cov
        self.active_policies = int(self.active_policies) + 1
        self.annual_premium_run_rate = int(self.annual_premium_run_rate) + premium * YEAR_SECS // duration_secs
        self.pool_assets = assets + premium
        self.total_premiums = int(self.total_premiums) + premium
        self._log(pid, "POLICY_CREATED", f"coverage {cov}, premium {premium}, {up} bps uptime, {lat}ms limit")
        # interaction: refund any overpayment
        self._pay(holder, paid - premium)
        return pid

    @gl.public.write
    def expire_policy(self, policy_id: u256) -> str:
        """Permissionless: release the coverage of a policy that has run its
        term (or whose staged claim was never settled) back to the pool."""
        p = self._get(policy_id)
        now = self._now()
        if p.status == ST_ACTIVE and now >= int(p.expires_at):
            self._close(policy_id, ST_EXPIRED)
            self._log(policy_id, "POLICY_EXPIRED", "term ended with no confirmed breach")
            return ST_EXPIRED
        if p.status == ST_BREACH_PENDING and now > int(p.settle_at) + SETTLE_WINDOW:
            self._close(policy_id, ST_LAPSED)
            self._log(policy_id, "CLAIM_LAPSED", "staged claim not settled within the settlement window")
            return ST_LAPSED
        raise gl.vm.UserError(f"{ERR_STATE} policy cannot be expired yet")

    # ----------------------------------------------------------------- probes
    @gl.public.write.payable
    def trigger_probe(self, policy_id: u256) -> dict:
        """Permissionless health probe. Requires a spam bond: refunded when the
        probe finds a failure, forfeited to underwriters when it finds none."""
        p = self._get(policy_id)
        if p.status != ST_ACTIVE:
            raise gl.vm.UserError(f"{ERR_STATE} policy is not ACTIVE")
        now = self._now()
        if now < int(p.active_from):
            raise gl.vm.UserError(f"{ERR_TOO_SOON} policy is still in its activation delay")
        if now >= int(p.expires_at):
            raise gl.vm.UserError(f"{ERR_STATE} policy term has ended")
        if int(p.last_probe_at) > 0 and now < int(p.last_probe_at) + int(p.probe_interval):
            raise gl.vm.UserError(f"{ERR_TOO_SOON} probe interval has not elapsed")
        bond = int(gl.message.value)
        if bond < int(self.probe_bond):
            raise gl.vm.UserError(f"{ERR_EXPECTED} probe bond {int(self.probe_bond)} required")

        obs = self._consensus_probe(p, now)

        # --- measurement window rollover ---
        if int(p.window_started) == 0 or now - int(p.window_started) >= MEASUREMENT_WINDOW:
            p.window_started = now
            p.samples_total = 0
            p.samples_ok = 0
        p.samples_total = int(p.samples_total) + 1
        self.total_probes = int(self.total_probes) + 1
        p.last_probe_at = now
        p.last_latency_ms = max(0, int(obs["latency_ms"]))
        p.last_reason = str(obs["reason"])
        p.last_ok = bool(obs["ok"])
        if obs["ok"]:
            p.samples_ok = int(p.samples_ok) + 1
            p.consecutive_failures = 0
            p.baseline_ok = True
        else:
            p.consecutive_failures = int(p.consecutive_failures) + 1
        if int(obs["block"]) > 0 and obs["reason"] in (R_OK, R_HIGH_LATENCY):
            p.last_block = int(obs["block"])

        text = _describe(obs, int(p.max_latency_ms))
        self._log(policy_id, "PROBE", text, obs)

        # --- bond settlement + breach staging ---
        forfeit = 0
        if obs["ok"]:
            forfeit = int(self.probe_bond)
            self.pool_assets = int(self.pool_assets) + forfeit
            self.total_bond_forfeits = int(self.total_bond_forfeits) + forfeit
        staged = self._maybe_stage_breach(policy_id, p, now)
        refund = bond - forfeit
        self._pay(gl.message.sender_address, refund)

        return {
            "ok": bool(obs["ok"]),
            "reason": str(obs["reason"]),
            "status": int(obs["status"]),
            "latency_ms": int(obs["latency_ms"]),
            "block": int(obs["block"]),
            "breach_staged": staged,
            "consecutive_failures": int(p.consecutive_failures),
            "uptime_bps": self._uptime_bps(p),
        }

    @gl.public.write.payable
    def settle_claim(self, policy_id: u256) -> dict:
        """Re-verifies a staged breach after the grace period with a fresh
        consensus probe. Pays the HOLDER iff the endpoint is still failing;
        otherwise dismisses the claim and the policy resumes."""
        p = self._get(policy_id)
        if p.status != ST_BREACH_PENDING:
            raise gl.vm.UserError(f"{ERR_STATE} no staged claim on this policy")
        now = self._now()
        if now < int(p.settle_at):
            raise gl.vm.UserError(f"{ERR_TOO_SOON} claim grace period has not elapsed")
        if now > int(p.settle_at) + SETTLE_WINDOW:
            raise gl.vm.UserError(f"{ERR_STATE} claim lapsed; call expire_policy")
        bond = int(gl.message.value)
        if bond < int(self.probe_bond):
            raise gl.vm.UserError(f"{ERR_EXPECTED} probe bond {int(self.probe_bond)} required")

        obs = self._consensus_probe(p, now)
        text = _describe(obs, int(p.max_latency_ms))
        coverage = int(p.coverage)

        if not obs["ok"]:
            payout = _vested_payout(coverage, now - int(p.active_from))
            assets = int(self.pool_assets)
            if payout > assets:
                payout = assets  # bounded: can never exceed pool depth
            # Claim velocity ceiling: a wave of breaches is paid across epochs. The
            # claim stays staged (and the whole call reverts, refunding the bond)
            # until the next epoch has room; the 14-day settlement window outlasts the queue.
            # The first payout of an epoch is always allowed (progress guarantee): the
            # ceiling shrinks with the pool and could otherwise fall below one claim.
            paid_now, ceiling = self._velocity_window(now, assets)
            if paid_now > 0 and paid_now + payout > ceiling:
                raise gl.vm.UserError(f"{ERR_VELOCITY} epoch payout ceiling reached; retry next epoch")
            epoch = now // EPOCH_SECONDS
            if epoch != int(self.velocity_epoch):
                self.velocity_epoch = epoch
                self.velocity_base = assets
                self.velocity_paid = 0
            self.velocity_paid = int(self.velocity_paid) + payout
            self.total_probes = int(self.total_probes) + 1
            holder = p.holder
            p.payout = payout
            p.last_reason = str(obs["reason"])
            p.last_ok = False
            p.last_probe_at = now
            p.last_latency_ms = max(0, int(obs["latency_ms"]))
            self._close(policy_id, ST_PAID)  # releases lock + reservation
            self.pool_assets = assets - payout
            self.total_payouts = int(self.total_payouts) + payout
            self._log(
                policy_id,
                "PAYOUT",
                f"re-verification confirmed breach ({text}); paid {payout} of {coverage} coverage",
                obs,
            )
            self._pay(holder, payout)
            self._pay(gl.message.sender_address, bond)
            return {"paid": True, "payout": str(payout), "reason": str(obs["reason"])}

        # Endpoint recovered during the grace period: dismiss, resume cover.
        self.total_probes = int(self.total_probes) + 1
        forfeit = int(self.probe_bond)
        self.pool_assets = int(self.pool_assets) + forfeit
        self.total_bond_forfeits = int(self.total_bond_forfeits) + forfeit
        self.reserved_payouts = int(self.reserved_payouts) - coverage
        p.status = ST_ACTIVE
        p.consecutive_failures = 0
        p.last_ok = True
        p.last_reason = R_OK
        p.last_probe_at = now
        p.last_latency_ms = max(0, int(obs["latency_ms"]))
        if int(obs["block"]) > 0:
            p.last_block = int(obs["block"])
        self._log(policy_id, "CLAIM_DISMISSED", f"endpoint recovered during grace period ({text})", obs)
        self._pay(gl.message.sender_address, bond - forfeit)
        return {"paid": False, "payout": "0", "reason": R_OK}

    # ---------------------------------------------------------------- internal
    def _consensus_probe(self, p: Policy, now: int) -> dict:
        url = str(p.endpoint_url)
        mode = str(p.probe_mode)
        max_latency = int(p.max_latency_ms)
        last_block = int(p.last_block)
        elapsed = now - int(p.last_probe_at) if int(p.last_probe_at) > 0 else 0

        def leader() -> dict:
            return _measure(url, mode, max_latency, last_block, elapsed)

        def validator(leaders_res: gl.vm.Result) -> bool:
            return _verdicts_agree(leaders_res, leader, max_latency, mode == MODE_RPC)

        return gl.vm.run_nondet(leader, validator)

    def _net_assets(self) -> int:
        """Pool assets net of capital reserved for staged claims: the basis for
        share pricing and redemptions."""
        assets = int(self.pool_assets)
        reserved = int(self.reserved_payouts)
        return assets - reserved if assets > reserved else 0

    def _velocity_window(self, now: int, assets: int) -> tuple:
        """(paid so far this epoch, payout ceiling for this epoch)."""
        epoch = now // EPOCH_SECONDS
        if epoch == int(self.velocity_epoch) and int(self.velocity_base) > 0:
            return int(self.velocity_paid), int(self.velocity_base) * MAX_EPOCH_PAYOUT_BPS // BPS
        return 0, assets * MAX_EPOCH_PAYOUT_BPS // BPS

    def _uptime_bps(self, p: Policy) -> int:
        total = int(p.samples_total)
        if total == 0:
            return BPS
        return int(p.samples_ok) * BPS // total

    def _maybe_stage_breach(self, pid: int, p: Policy, now: int) -> bool:
        if int(p.consecutive_failures) < BREACH_CONSECUTIVE or not p.baseline_ok:
            return False
        if self._uptime_bps(p) >= int(p.min_uptime_bps):
            return False
        p.status = ST_BREACH_PENDING
        p.settle_at = now + int(self.claim_grace)
        p.claim_count = int(p.claim_count) + 1
        self.reserved_payouts = int(self.reserved_payouts) + int(p.coverage)
        self.total_breaches = int(self.total_breaches) + 1
        self._log(
            pid,
            "BREACH_CONFIRMED",
            f"{int(p.consecutive_failures)} consecutive failures; uptime {self._uptime_bps(p)} bps "
            f"< {int(p.min_uptime_bps)} bps SLA; payout reserved, grace until {int(p.settle_at)}",
        )
        return True

    def _close(self, pid: int, status: str) -> None:
        """Move a live policy to a terminal state and release all its exposure."""
        p = self.policies[pid]
        cov = int(p.coverage)
        if p.status == ST_BREACH_PENDING:
            self.reserved_payouts = int(self.reserved_payouts) - cov
        self.locked_coverage = int(self.locked_coverage) - cov
        self.host_exposure[str(p.apex)] = int(self.host_exposure[str(p.apex)]) - cov
        holder_hex = _hex(p.holder)
        self.holder_exposure[holder_hex] = int(self.holder_exposure[holder_hex]) - cov
        self.active_policies = int(self.active_policies) - 1
        self.annual_premium_run_rate = int(self.annual_premium_run_rate) - int(p.premium) * YEAR_SECS // int(p.duration_secs)
        p.status = status

    def _get(self, policy_id: int) -> Policy:
        if policy_id not in self.policies:
            raise gl.vm.UserError(f"{ERR_STATE} unknown policy")
        return self.policies[policy_id]

    def _pay(self, to: Address, amount: int) -> None:
        if amount > 0:
            gl.chain.Account(to).emit_transfer(amount, on="finalized")

    def _log(self, pid: int, kind: str, detail: str, obs: dict | None = None) -> None:
        rec = {
            "i": len(self.incidents),
            "t": self._now(),
            "policy_id": pid,
            "kind": kind,
            "detail": detail,
            "by": _hex(gl.message.sender_address),
        }
        if obs is not None:
            rec["ok"] = bool(obs["ok"])
            rec["reason"] = str(obs["reason"])
            rec["status"] = int(obs["status"])
            rec["latency_ms"] = int(obs["latency_ms"])
            rec["block"] = int(obs["block"])
        self.incidents.append(json.dumps(rec, sort_keys=True))

    def _policy_dict(self, pid: int) -> dict:
        p = self.policies[pid]
        return {
            "id": int(pid),
            "holder": _hex(p.holder),
            "endpoint_url": str(p.endpoint_url),
            "host": str(p.host),
            "apex": str(p.apex),
            "probe_mode": str(p.probe_mode),
            "max_latency_ms": int(p.max_latency_ms),
            "min_uptime_bps": int(p.min_uptime_bps),
            "probe_interval": int(p.probe_interval),
            "coverage": str(int(p.coverage)),
            "premium": str(int(p.premium)),
            "created_at": int(p.created_at),
            "active_from": int(p.active_from),
            "expires_at": int(p.expires_at),
            "status": str(p.status),
            "samples_total": int(p.samples_total),
            "samples_ok": int(p.samples_ok),
            "uptime_bps": self._uptime_bps(p),
            "consecutive_failures": int(p.consecutive_failures),
            "baseline_ok": bool(p.baseline_ok),
            "last_probe_at": int(p.last_probe_at),
            "last_block": int(p.last_block),
            "last_latency_ms": int(p.last_latency_ms),
            "last_reason": str(p.last_reason),
            "last_ok": bool(p.last_ok),
            "settle_at": int(p.settle_at),
            "claim_count": int(p.claim_count),
            "payout": str(int(p.payout)),
        }

    def _now(self) -> int:
        # Deterministic block clock: GenVM patches datetime.now() to the
        # transaction timestamp; the direct harness patches it for warp().
        return int(datetime.now(timezone.utc).timestamp())
