# v0.4.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# PulseSLA -- Parametric SLA & Infrastructure Downtime Insurance Protocol.
#
# Underwriters pool native GEN and earn premiums; infrastructure teams buy
# parametric policies on a *registered* JSON-RPC endpoint; anyone may trigger a
# health round by posting a small bond.
#
# Moral-hazard model. The protocol must not pay a holder who controls the
# insured service, picks the observations that establish the breach, and
# collects a vested payout without independent proof. Three layers close that:
#
#   1. AUTHENTICATED REGISTRY -- a policy never carries a holder-supplied URL.
#      It references an `endpoint_id` listed by the governor: a public provider
#      endpoint bound to its domain, chain id and a commitment hash, verified by
#      consensus (`eth_chainId`) at listing, immutable afterwards, and insurable
#      only after a listing delay.
#   2. CORROBORATED TELEMETRY -- every round measures the insured endpoint AND
#      independent reference endpoints (other providers, same chain). The round
#      verdict is HEALTHY / FAILING / INCONCLUSIVE; a failure only counts when a
#      quorum of references is healthy (otherwise the outage is the observer's,
#      not the provider's), staleness is judged against the reference head, and
#      every validator must independently reach the same verdict.
#   3. CONTINUITY + VESTING -- a breach needs consecutive failing rounds that
#      span a minimum wall-clock time AND a minimum number of reference-chain
#      blocks, then a grace period and a fresh corroborated re-verification.
#      The confirmed payout is released after a cooldown, linearly, on top of
#      the age ramp, per-epoch ceiling and exposure caps.
#
# Enforced SLA metrics are exactly two: availability (HTTP 200 + a valid
# JSON-RPC block number) and freshness (block height vs the reference head).
# Latency is NOT enforced: GenVM has no clock that advances across a web
# request, and a single vantage point's latency is not a representative
# measurement. It was removed rather than left as an unenforceable promise.
#
# Measurement model (what a failing round does and does not prove):
#   * A round is a point observation. A streak of failing rounds is continuous
#     only if each round follows the previous failing round within
#     MAX_PROBE_GAP_SECS; a longer silence breaks the streak (unobserved time
#     is never turned into downtime), and each failing round credits at most
#     one probe interval, which create_policy caps at MAX_INTERVAL_BLOCKS.
#   * Nothing is observed after a policy's term: probes and settlements are
#     rejected from `expires_at`, a staged claim must be confirmed inside the
#     term, and the payout age-ramp is frozen at the moment the breach was
#     staged, so waiting cannot inflate a claim.
#   * create_policy rejects parameter sets from which a claim could not be
#     staged and confirmed inside the term (see _min_duration_blocks).
#
# Solvency invariant (checked by every test):
#     reserved_payouts <= locked_coverage <= pool_assets.
# Coverage is locked at policy creation, so a payout (always <= coverage) lowers
# pool_assets and locked_coverage together and can never overdraw the pool.

import hashlib
import ipaddress
import json
import re
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
ERR_VELOCITY = "[VELOCITY_LIMIT]"
ERR_DEPOSITS_FROZEN = "[DEPOSITS_FROZEN_DURING_PENDING_CLAIMS]"
ERR_UNAUTH_ENDPOINT = "[UNAUTHENTICATED_ENDPOINT]"  # not in the registry / not insurable
ERR_REGISTRY = "[REGISTRY_REJECTED]"  # a listing failed validation or authentication
ERR_INCONCLUSIVE = "[INCONCLUSIVE]"  # round could not be corroborated; nothing changed

# --- Policy lifecycle -------------------------------------------------------
ST_ACTIVE = "ACTIVE"
ST_BREACH_PENDING = "BREACH_PENDING"  # claim staged; payout reserved
ST_VESTING = "VESTING"  # breach confirmed; payout releasing over the vesting schedule
ST_PAID = "PAID"  # fully released
ST_EXPIRED = "EXPIRED"
ST_LAPSED = "LAPSED"  # claim not settled inside the settlement window

EP_LISTED = "LISTED"
EP_DELISTED = "DELISTED"

# --- Round verdicts and reasons ----------------------------------------------
V_HEALTHY = "HEALTHY"
V_FAILING = "FAILING"
V_INCONCLUSIVE = "INCONCLUSIVE"
VERDICTS = (V_HEALTHY, V_FAILING, V_INCONCLUSIVE)

R_OK = "OK"
R_HTTP_ERROR = "HTTP_ERROR"
R_UNREACHABLE = "UNREACHABLE"
R_BAD_PAYLOAD = "BAD_PAYLOAD"
R_STALE_BLOCK = "STALE_BLOCK"  # target lags the corroborated reference head
R_RATE_LIMITED = "RATE_LIMITED"  # HTTP 429: not a representative outage -> INCONCLUSIVE
R_NO_BASELINE = "NO_BASELINE"  # reference quorum unavailable -> INCONCLUSIVE
TARGET_FAIL_REASONS = (R_HTTP_ERROR, R_UNREACHABLE, R_BAD_PAYLOAD, R_RATE_LIMITED)

# --- Economics (atto-scale: value * 10 ** 18) -------------------------------
ATTO = 10**18
MIN_DEPOSIT = 10**15
# While any coverage, claim or payout is outstanding the pool may never be left
# with fewer shares than this. It keeps the last underwriter's position real
# (never zero) and bounds the price per share when a reserve later frees up, so
# a dust-sized position cannot round new depositors down to nothing.
MIN_TOTAL_SHARES = 10**12
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
MAX_HOST_BPS = 2000  # all policies on one provider domain <= 20%
MAX_HOLDER_BPS = 2000  # all policies of one holder <= 20%
MAX_UTILIZATION_BPS = 8000  # locked coverage <= 80% of the pool

# --- Policy parameter bounds -------------------------------------------------
MIN_UPTIME_BPS = 9000
MAX_UPTIME_BPS = 9999
MIN_DURATION_BLOCKS = 300  # ~1 hour
MAX_DURATION_BLOCKS = 2_628_000  # ~1 year
MIN_INTERVAL_BLOCKS = 5  # ~1 minute
MAX_INTERVAL_BLOCKS = 150  # ~30 minutes: one failing round may credit at most this much downtime

# --- Authenticated registry --------------------------------------------------
MAX_ENDPOINTS = 32
LISTING_DELAY_SECS = 24 * 3600  # a new listing is insurable only after this
ATTESTATION_PREFIX = "pulsesla/v1"
MAX_ID_LEN = 32
MAX_PROVIDER_LEN = 48
MAX_CHAIN_ID = 2**32

# --- Corroboration -------------------------------------------------------------
MIN_REFERENCES = 3  # independent-provider references required per round
MAX_REFERENCES = 4
MAX_LAG_BLOCKS = 50  # target this far behind the reference head is stale (~10 min)

# --- Continuity and staged claims ----------------------------------------------
BREACH_CONSECUTIVE = 3  # consecutive FAILING rounds needed to stage a claim
MIN_OUTAGE_SECS = 15 * 60  # ...spanning at least this much block-clock time
MIN_OUTAGE_BLOCKS = 25  # ...and at least this many reference-chain blocks
MAX_PROBE_GAP_SECS = 3600  # a failing streak survives at most this long between failing rounds
MIN_SLACK_ROUNDS = 2  # extra probe intervals a policy term must leave for keeper timing
MEASUREMENT_WINDOW = 30 * 24 * 3600  # uptime window (30 days)
MIN_UPTIME_WINDOW = 24 * 3600  # uptime is never judged on a window shorter than this
SETTLE_WINDOW = 14 * 24 * 3600  # after settle_at, a claim lapses (outlasts the velocity queue)
PAYOUT_FLOOR_BPS = 2500  # a brand-new policy vests 25% of coverage ...
PAYOUT_RAMP_SECS = 7 * 24 * 3600  # ... rising linearly to 100% over 7 days
PAYOUT_COOLDOWN_SECS = 24 * 3600  # nothing is releasable for this long after confirmation
PAYOUT_VEST_SECS = 3 * 24 * 3600  # ...then the payout streams out linearly over this

# Rogue-leader bounds (see _round_agrees): independent observations of one
# chain can differ by a few blocks, never by more than this.
MAX_BLOCK_DRIFT = 10  # leader may be up to this many blocks BEHIND a validator
MAX_BLOCK_AHEAD = 2  # ...but at most this many AHEAD, so a reported head is a conservative lower bound
MAX_BLOCK_HEIGHT = 2**53  # beyond any real chain; rejects absurd leader values

# Claim velocity: payouts per epoch are capped at a share of pool assets, so a
# wave of simultaneous breaches is paid out over several epochs, not in one step.
EPOCH_SECONDS = 24 * 3600
MAX_EPOCH_PAYOUT_BPS = 3000  # 30% of pool assets per epoch

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
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,31}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")


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
    encodings (hex, decimal, octal) and no internal-only suffixes. Applied to
    governor listings, which are additionally https-only."""
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
    cycling subdomains (a.node.io, b.node.io, ...) cannot bypass the per-provider
    cap, and to keep a provider from corroborating itself. IP literals are
    returned unchanged."""
    labels = host.split(".")
    if len(labels) <= 2 or all(p.isdigit() for p in labels):
        return host
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_LABEL_SUFFIXES and len(labels) >= 3:
        return ".".join(labels[-3:])
    return last_two


def _attestation(endpoint_id: str, provider: str, domain: str, chain_id: int, url: str) -> str:
    """Commitment hash a listing must carry. Anyone can recompute it off-chain
    and compare it with the provider's own published documentation."""
    material = f"{ATTESTATION_PREFIX}|{endpoint_id}|{provider}|{domain}|{chain_id}|{url}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


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


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def _rounds_needed(min_uptime_bps: int, interval_secs: int) -> int:
    """Failing rounds after the healthy baseline that are needed to stage a
    claim at the best case (breach early in the window, so the uptime
    denominator is the MIN_UPTIME_WINDOW floor): the consecutive-round count,
    the minimum outage span, and enough credited downtime to fall below the
    chosen SLA."""
    need_down = _ceil_div((BPS - min_uptime_bps + 1) * MIN_UPTIME_WINDOW, BPS)
    by_span = _ceil_div(MIN_OUTAGE_SECS, interval_secs) + 1
    by_down = _ceil_div(need_down, interval_secs)
    return max(BREACH_CONSECUTIVE, by_span, by_down)


def _min_duration_blocks(min_uptime_bps: int, interval_blocks: int, claim_grace_secs: int) -> int:
    """Shortest term (in blocks) in which a claim can be established at all:
    one healthy baseline round, the failing rounds, the claim grace period and
    a little slack for keeper timing -- and the confirming round must still
    fall strictly inside the term."""
    interval = interval_blocks * BLOCK_SECONDS
    rounds = _rounds_needed(min_uptime_bps, interval)
    secs = (rounds + MIN_SLACK_ROUNDS) * interval + claim_grace_secs
    need = secs // BLOCK_SECONDS + 1
    return need if need > MIN_DURATION_BLOCKS else MIN_DURATION_BLOCKS


def _vested_payout(coverage: int, age_secs: int) -> int:
    """Payout vests linearly from PAYOUT_FLOOR_BPS to 100% of coverage over
    PAYOUT_RAMP_SECS of policy age -- the anti-collusion staging curve. The
    age is always the age at which the breach was STAGED, never the age at
    settlement."""
    age = age_secs if age_secs > 0 else 0
    if age >= PAYOUT_RAMP_SECS:
        return coverage
    bps = PAYOUT_FLOOR_BPS + (BPS - PAYOUT_FLOOR_BPS) * age // PAYOUT_RAMP_SECS
    return coverage * bps // BPS


def _releasable(payout: int, vest_start: int, now: int) -> int:
    """Cumulative amount of a confirmed payout that may have been released by
    `now`: nothing during the cooldown, then a linear stream."""
    t = now - vest_start - PAYOUT_COOLDOWN_SECS
    if t <= 0:
        return 0
    if t >= PAYOUT_VEST_SECS:
        return payout
    return payout * t // PAYOUT_VEST_SECS


def _rpc_call(url: str, method: str) -> tuple:
    """POST one JSON-RPC request. Never raises: an endpoint that cannot be
    reached IS the observation. Returns (reachable, status, parsed result)."""
    reachable = True
    status = 0
    body_text = ""
    try:
        res = gl.nondet.web.post(
            url,
            body=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": []}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        status = int(getattr(res, "status", 0) or 0)
        raw = getattr(res, "body", None)
        if isinstance(raw, (bytes, bytearray)):
            body_text = bytes(raw).decode("utf-8", errors="replace")
        elif isinstance(raw, str):
            body_text = raw
    except Exception:
        reachable = False
    result = -1
    if reachable and status == 200:
        try:
            data = json.loads(body_text)
            value = data.get("result") if isinstance(data, dict) else None
            if isinstance(value, str) and value.startswith("0x") and len(value) > 2:
                result = int(value, 16)
        except Exception:
            result = -1
    return reachable, status, result


def _observe(url: str) -> dict:
    """One availability observation of one endpoint (`eth_blockNumber`).
    Runs inside the non-deterministic block on the leader AND on every
    validator. Returns a calldata-safe dict."""
    reachable, status, block = _rpc_call(url, "eth_blockNumber")
    if not reachable:
        reason = R_UNREACHABLE
    elif status == 429:
        reason = R_RATE_LIMITED
    elif status != 200:
        reason = R_HTTP_ERROR
    elif block <= 0:
        reason = R_BAD_PAYLOAD
        block = -1
    else:
        reason = R_OK
    return {"ok": reason == R_OK, "reason": reason, "status": status, "block": block}


def _classify(t_ok: bool, t_reason: str, t_block: int, refs: list, n_refs: int) -> tuple:
    """Deterministic round verdict from raw observations.

    Returns (verdict, reason, ref_head, refs_ok).

    * Fewer than MIN_REFERENCES references, or no strict-majority of them
      healthy, means the baseline is missing: the failure (if any) cannot be
      told apart from the observer's own connectivity -> INCONCLUSIVE.
    * ref_head is the LOWER median of healthy reference heights, so a single
      ahead-of-the-pack reference cannot make a healthy target look stale.
    * A target behind ref_head by more than MAX_LAG_BLOCKS is stale.
    * A rate-limited target is INCONCLUSIVE: throttling is not a representative
      provider outage and must not be inducible by a hostile holder."""
    healthy = sorted(int(r["block"]) for r in refs if r["ok"] and int(r["block"]) > 0)
    quorum = n_refs // 2 + 1
    if n_refs < MIN_REFERENCES or len(healthy) < quorum:
        return V_INCONCLUSIVE, R_NO_BASELINE, -1, len(healthy)
    head = healthy[(len(healthy) - 1) // 2]
    if t_ok:
        if t_block + MAX_LAG_BLOCKS < head:
            return V_FAILING, R_STALE_BLOCK, head, len(healthy)
        return V_HEALTHY, R_OK, head, len(healthy)
    if t_reason == R_RATE_LIMITED:
        return V_INCONCLUSIVE, R_RATE_LIMITED, head, len(healthy)
    return V_FAILING, t_reason, head, len(healthy)


def _round(target_url: str, refs: list) -> dict:
    """One corroborated round: the target plus every reference endpoint.
    `refs` is a list of (id, url). Never raises."""
    t = _observe(target_url)
    observed = []
    for ref_id, ref_url in refs:
        o = _observe(ref_url)
        observed.append({"id": ref_id, "ok": o["ok"], "block": o["block"]})
    verdict, reason, head, refs_ok = _classify(t["ok"], t["reason"], t["block"], observed, len(refs))
    return {
        "verdict": verdict,
        "reason": reason,
        "status": t["status"],
        "block": t["block"],
        "ref_head": head,
        "refs_ok": refs_ok,
        "refs_total": len(refs),
        "t_ok": t["ok"],
        "t_reason": t["reason"],
        "refs": observed,
    }


def _sane_height(value, ok: bool) -> bool:
    if not isinstance(value, int) or isinstance(value, bool):
        return False
    if value < -1 or value == 0 or value > MAX_BLOCK_HEIGHT:
        return False
    return value > 0 if ok else True


def _round_agrees(leaders_res, mine_fn, expected_ids: list) -> bool:
    """Validator rule: independent corroboration.

    1. The leader's result must be well-formed and EXACTLY cover the expected
       reference set (a leader cannot drop an inconvenient reference).
    2. The leader's verdict must be what its own raw observations imply
       (`_classify` is re-run), so derived fields cannot be forged.
    3. This validator re-measures the target and every reference itself and
       must reach the SAME verdict. The failure class need not match.
    4. Heights are bounded asymmetrically against this validator's own
       observation: validator - MAX_BLOCK_DRIFT <= leader <= validator +
       MAX_BLOCK_AHEAD, for both the target and the reference head, so a
       Byzantine leader cannot inflate the reference head to fabricate lag."""
    if not isinstance(leaders_res, gl.vm.Return):
        return False
    lead = leaders_res.calldata
    if not isinstance(lead, dict):
        return False
    for key in ("verdict", "reason", "status", "block", "ref_head", "refs_ok", "refs_total", "t_ok", "t_reason", "refs"):
        if key not in lead:
            return False
    if lead["verdict"] not in VERDICTS or not isinstance(lead["reason"], str):
        return False
    if not isinstance(lead["t_ok"], bool) or not isinstance(lead["t_reason"], str):
        return False
    if lead["t_ok"] != (lead["t_reason"] == R_OK):
        return False
    if not lead["t_ok"] and lead["t_reason"] not in TARGET_FAIL_REASONS:
        return False
    for key in ("status", "refs_ok", "refs_total"):
        if not isinstance(lead[key], int) or isinstance(lead[key], bool):
            return False
    if lead["t_ok"] and lead["status"] != 200:
        return False
    if not _sane_height(lead["block"], lead["t_ok"]):
        return False
    if not isinstance(lead["ref_head"], int) or isinstance(lead["ref_head"], bool):
        return False
    refs = lead["refs"]
    if not isinstance(refs, list) or len(refs) != len(expected_ids) or lead["refs_total"] != len(expected_ids):
        return False
    for ref, want in zip(refs, expected_ids):
        if not isinstance(ref, dict) or ref.get("id") != want or not isinstance(ref.get("ok"), bool):
            return False
        if not _sane_height(ref.get("block"), ref["ok"]):
            return False
    verdict, reason, head, refs_ok = _classify(lead["t_ok"], lead["t_reason"], lead["block"], refs, len(expected_ids))
    if (verdict, reason, head, refs_ok) != (lead["verdict"], lead["reason"], lead["ref_head"], lead["refs_ok"]):
        return False
    mine = mine_fn()
    if mine["verdict"] != lead["verdict"]:
        return False
    if lead["verdict"] == V_INCONCLUSIVE:
        return True
    pairs = [(lead["ref_head"], mine["ref_head"])]
    if lead["block"] > 0 and mine["block"] > 0:
        pairs.append((lead["block"], mine["block"]))
    for lead_h, my_h in pairs:
        if my_h <= 0:
            return False
        delta = lead_h - my_h
        if delta > MAX_BLOCK_AHEAD or -delta > MAX_BLOCK_DRIFT:
            return False
    return True


def _describe(obs: dict) -> str:
    verdict, reason = obs["verdict"], obs["reason"]
    corroboration = f"{obs['refs_ok']}/{obs['refs_total']} references healthy, reference head {obs['ref_head']}"
    if verdict == V_HEALTHY:
        return f"healthy: HTTP 200, block {obs['block']} ({corroboration})"
    if verdict == V_INCONCLUSIVE:
        if reason == R_RATE_LIMITED:
            return f"endpoint rate-limited the observers; not a representative outage ({corroboration})"
        return f"not corroborated: reference baseline unavailable ({obs['refs_ok']}/{obs['refs_total']} healthy)"
    if reason == R_UNREACHABLE:
        return f"endpoint unreachable while the network is healthy ({corroboration})"
    if reason == R_HTTP_ERROR:
        return f"HTTP {obs['status']} returned, SLA requires 200 ({corroboration})"
    if reason == R_BAD_PAYLOAD:
        return f"eth_blockNumber returned an invalid or missing result ({corroboration})"
    return f"block {obs['block']} is more than {MAX_LAG_BLOCKS} behind reference head {obs['ref_head']} ({corroboration})"


@allow_storage
@dataclass
class Endpoint:
    """An authenticated, governor-listed provider endpoint. Immutable once
    listed: only `status` ever changes (delisting)."""
    endpoint_id: str
    provider: str
    domain: str  # registrable domain the endpoint must live under
    url: str  # public, keyless JSON-RPC URL (probed verbatim)
    host: str
    apex: str  # registrable domain (eTLD+1): provider identity for exposure + independence
    chain_id: u256
    attestation: str  # sha256 commitment, see _attestation()
    listed_at: u256
    status: str


@allow_storage
@dataclass
class Policy:
    holder: Address
    endpoint_id: str
    endpoint_url: str  # snapshot of the registry listing (listings are immutable)
    host: str
    apex: str  # registrable domain (eTLD+1): the unit of the per-provider exposure cap
    chain_id: u256
    min_uptime_bps: u256
    probe_interval: u256  # seconds
    coverage: u256
    premium: u256
    duration_secs: u256
    created_at: u256
    active_from: u256
    expires_at: u256
    status: str
    # --- corroborated telemetry (current measurement window) ---
    window_started: u256
    downtime_secs: u256  # sum of probe_interval over corroborated FAILING rounds (each capped at one interval)
    samples_total: u256  # corroborated rounds (HEALTHY + FAILING)
    samples_ok: u256
    inconclusive_rounds: u256
    consecutive_failures: u256
    last_fail_at: u256  # block-clock time of the latest failing round of the current streak
    outage_started_at: u256  # block-clock time of the first round of the current failing streak
    outage_start_head: u256  # reference head at that round
    last_ref_head: u256
    baseline_ok: bool  # endpoint has been corroborated healthy at least once
    last_probe_at: u256
    last_block: u256
    last_reason: str
    last_ok: bool
    # --- staged claim and vesting ---
    breach_at: u256  # time the current/last claim was staged: fixes the payout age-ramp
    settle_at: u256
    claim_count: u256
    payout: u256  # confirmed payout (fixed at confirmation)
    released: u256  # portion of `payout` already paid out
    vest_start: u256


class PulseSLA(gl.contract.Contract):
    # Governance and the authenticated registry.
    governor: Address
    endpoints: TreeMap[str, Endpoint]
    endpoint_ids: DynArray[str]
    # Underwriting pool (share-based accounting).
    pool_assets: u256  # GEN owned by underwriters: deposits + premiums - released payouts
    total_shares: u256
    shares: TreeMap[str, u256]  # underwriter hex -> shares
    # Exposure book.
    locked_coverage: u256  # coverage of every live policy + unreleased confirmed payouts
    reserved_payouts: u256  # subset of locked: staged claims (coverage) + owed_payouts
    owed_payouts: u256  # subset of reserved: confirmed, not yet released
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
    velocity_base: u256  # pool assets when the epoch's first confirmation was made
    # Immutable protocol parameters (set at deploy).
    activation_delay: u256
    claim_grace: u256
    probe_bond: u256
    # Append-only incident log: JSON strings.
    incidents: DynArray[str]

    def __init__(self, activation_delay_secs: u256, claim_grace_secs: u256, probe_bond: u256):
        self.governor = gl.message.sender_address
        self.pool_assets = 0
        self.total_shares = 0
        self.locked_coverage = 0
        self.reserved_payouts = 0
        self.owed_payouts = 0
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
        reserved = int(self.reserved_payouts)
        owed = int(self.owed_payouts)
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
            "reserved_payouts": str(reserved),
            "owed_payouts": str(owed),
            "staged_claims": str(reserved - owed if reserved > owed else 0),
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
            "listed_endpoints": len(self.endpoint_ids),
            "solvent": locked <= assets and reserved <= locked and owed <= reserved,
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
            "withdrawable": str(self._withdrawable(value, free, shares, locked)),
        }

    @gl.public.view
    def get_governor(self) -> str:
        return _hex(self.governor)

    @gl.public.view
    def get_endpoint(self, endpoint_id: str) -> dict:
        if endpoint_id not in self.endpoints:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} endpoint is not in the authenticated registry")
        return self._endpoint_dict(endpoint_id)

    @gl.public.view
    def list_endpoints(self, offset: u256, limit: u256) -> list:
        out = []
        i = int(offset)
        n = len(self.endpoint_ids)
        while i < n and len(out) < int(limit) and len(out) < 50:
            out.append(self._endpoint_dict(self.endpoint_ids[i]))
            i += 1
        return out

    @gl.public.view
    def get_references(self, endpoint_id: str) -> list:
        """The independent reference endpoints a round on `endpoint_id` is
        corroborated against (same chain, different provider domain)."""
        if endpoint_id not in self.endpoints:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} endpoint is not in the authenticated registry")
        ep = self.endpoints[endpoint_id]
        return [rid for rid, _ in self._references(int(ep.chain_id), str(ep.apex))]

    @gl.public.view
    def compute_attestation(self, endpoint_id: str, provider: str, domain: str, chain_id: u256, url: str) -> str:
        return _attestation(endpoint_id, provider, domain, int(chain_id), url)

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
    def min_insurable_duration(self, min_uptime_bps: u256, probe_interval_blocks: u256) -> int:
        """Shortest policy term (blocks) create_policy accepts for this uptime
        target and probe interval: below it no claim could be established."""
        up = int(min_uptime_bps)
        interval = int(probe_interval_blocks)
        if not (MIN_UPTIME_BPS <= up <= MAX_UPTIME_BPS):
            raise gl.vm.UserError(f"{ERR_PARAMS} min_uptime_bps out of range")
        if not (MIN_INTERVAL_BLOCKS <= interval <= MAX_INTERVAL_BLOCKS):
            raise gl.vm.UserError(f"{ERR_PARAMS} probe interval out of range")
        return _min_duration_blocks(up, interval, int(self.claim_grace))

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

    # --------------------------------------------------------------- registry
    @gl.public.write
    def register_endpoint(
        self,
        endpoint_id: str,
        provider: str,
        domain: str,
        chain_id: u256,
        url: str,
        attestation: str,
    ) -> str:
        """Governor-only. Lists a public provider endpoint as insurable (after
        LISTING_DELAY_SECS) and as a reference for other providers' rounds.

        Authentication is checked on-chain: the URL must be a public https
        endpoint under the declared registrable domain, the commitment hash
        must match, and a consensus `eth_chainId` call must return the declared
        chain id. Listings are immutable; to change one, delist and re-list."""
        self._only_governor()
        if not _ID_RE.match(endpoint_id) or len(endpoint_id) > MAX_ID_LEN:
            raise gl.vm.UserError(f"{ERR_REGISTRY} endpoint_id must be 2-32 chars of [a-z0-9-]")
        if endpoint_id in self.endpoints:
            raise gl.vm.UserError(f"{ERR_REGISTRY} endpoint_id already listed")
        if len(self.endpoint_ids) >= MAX_ENDPOINTS:
            raise gl.vm.UserError(f"{ERR_REGISTRY} registry is full")
        if not (2 <= len(provider) <= MAX_PROVIDER_LEN) or not provider.isprintable() or "|" in provider:
            raise gl.vm.UserError(f"{ERR_REGISTRY} provider name invalid")
        chain = int(chain_id)
        if not (1 <= chain <= MAX_CHAIN_ID):
            raise gl.vm.UserError(f"{ERR_REGISTRY} chain_id out of range")
        if not url.lower().startswith("https://") or not _is_safe_endpoint(url):
            raise gl.vm.UserError(f"{ERR_REGISTRY} url must be a public https endpoint")
        domain = domain.strip().lower()
        host = _hostname(url)
        if domain == "" or _apex(domain) != domain:
            raise gl.vm.UserError(f"{ERR_REGISTRY} domain must be a registrable domain")
        if host != domain and not host.endswith("." + domain):
            raise gl.vm.UserError(f"{ERR_REGISTRY} url host is not under the declared provider domain")
        for i in range(len(self.endpoint_ids)):
            if str(self.endpoints[self.endpoint_ids[i]].url) == url:
                raise gl.vm.UserError(f"{ERR_REGISTRY} url already listed")
        if not _HASH_RE.match(attestation) or attestation != _attestation(endpoint_id, provider, domain, chain, url):
            raise gl.vm.UserError(f"{ERR_REGISTRY} attestation hash does not match the listing")
        if self._verify_chain_id(url) != chain:
            raise gl.vm.UserError(f"{ERR_REGISTRY} endpoint did not authenticate as chain {chain}")

        now = self._now()
        self.endpoints[endpoint_id] = Endpoint(
            endpoint_id=endpoint_id,
            provider=provider,
            domain=domain,
            url=url,
            host=host,
            apex=_apex(host),
            chain_id=chain,
            attestation=attestation,
            listed_at=now,
            status=EP_LISTED,
        )
        self.endpoint_ids.append(endpoint_id)
        self._log(0, "ENDPOINT_LISTED", f"{endpoint_id}: {provider} ({domain}), chain {chain}, insurable from {now + LISTING_DELAY_SECS}")
        return endpoint_id

    @gl.public.write
    def delist_endpoint(self, endpoint_id: str) -> str:
        """Governor-only. Stops new policies on the endpoint and removes it from
        the reference set. Policies already written keep running against the
        immutable listing snapshot."""
        self._only_governor()
        if endpoint_id not in self.endpoints:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} endpoint is not in the authenticated registry")
        ep = self.endpoints[endpoint_id]
        if ep.status != EP_LISTED:
            raise gl.vm.UserError(f"{ERR_STATE} endpoint already delisted")
        ep.status = EP_DELISTED
        self._log(0, "ENDPOINT_DELISTED", endpoint_id)
        return EP_DELISTED

    @gl.public.write
    def transfer_governor(self, new_governor_hex: str) -> str:
        self._only_governor()
        new_governor = Address(new_governor_hex)
        if new_governor == self.governor:
            raise gl.vm.UserError(f"{ERR_PARAMS} already the governor")
        self.governor = new_governor
        self._log(0, "GOVERNOR_CHANGED", _hex(new_governor))
        return _hex(new_governor)

    # ------------------------------------------------------------ underwriting
    @gl.public.write.payable
    def deposit_underwriting(self) -> str:
        amount = int(gl.message.value)
        if amount < MIN_DEPOSIT:
            raise gl.vm.UserError(f"{ERR_PARAMS} deposit below minimum")
        # Deposits are frozen while any claim is STAGED (uncertain). Pricing them
        # on net assets would let someone stage a breach, buy discounted shares,
        # and profit when the claim is dismissed; pricing on gross would dilute
        # the LPs who carry the pending risk. Confirmed payouts that are merely
        # vesting are certain liabilities: they are already excluded from net
        # assets, so they do not freeze deposits.
        if self._staged_reserved() > 0:
            raise gl.vm.UserError(f"{ERR_DEPOSITS_FROZEN} a staged claim is reserved; deposits reopen when it settles")
        assets = int(self.pool_assets)
        net = self._net_assets()
        total = int(self.total_shares)
        if total == 0:
            # Unreachable by construction (the last holder cannot exit while any
            # capital is committed), but if it ever happened a depositor must
            # never be handed capital that nobody owns.
            if assets != 0 or int(self.locked_coverage) != 0:
                raise gl.vm.UserError(f"{ERR_STATE} pool holds capital with no shareholders; deposits closed")
            minted = amount
        else:
            if net == 0:
                raise gl.vm.UserError(f"{ERR_STATE} pool has no assets; deposits closed")
            minted = amount * total // net
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
        net = self._net_assets()  # assets minus capital reserved for staged claims and owed payouts
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
        # The last shareholder may not walk away from capital that is still
        # committed (live cover, staged claims, unreleased payouts): whatever
        # that capital frees later (a dismissed claim, a partial payout,
        # expiry) must stay owned by someone, not be captured by the next
        # depositor, and a dust-sized remainder must not distort the price.
        # Everyone can exit fully once nothing is locked.
        if locked > 0 and total - burn < MIN_TOTAL_SHARES:
            raise gl.vm.UserError(
                f"{ERR_LIQUIDITY} withdrawal would leave a dust-sized (or empty) pool while coverage, claims or payouts are outstanding"
            )
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
        endpoint_id: str,
        coverage_amount: u256,
        duration_blocks: u256,
        min_uptime_bps: u256,
        probe_interval_blocks: u256,
    ) -> u256:
        """Buy cover on a REGISTERED endpoint. There is no URL input: the
        probed endpoint is the immutable registry listing."""
        if endpoint_id not in self.endpoints:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} endpoint is not in the authenticated registry")
        ep = self.endpoints[endpoint_id]
        now = self._now()
        if ep.status != EP_LISTED:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} endpoint has been delisted")
        if now < int(ep.listed_at) + LISTING_DELAY_SECS:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} listing delay has not elapsed")
        if len(self._references(int(ep.chain_id), str(ep.apex))) < MIN_REFERENCES:
            raise gl.vm.UserError(f"{ERR_UNAUTH_ENDPOINT} fewer than {MIN_REFERENCES} independent reference providers on this chain")
        holder = gl.message.sender_address
        if holder == self.governor:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} the registry governor cannot hold policies")

        cov = int(coverage_amount)
        dur = int(duration_blocks)
        up = int(min_uptime_bps)
        interval = int(probe_interval_blocks)
        if cov < MIN_COVERAGE:
            raise gl.vm.UserError(f"{ERR_PARAMS} coverage below minimum")
        if not (MIN_DURATION_BLOCKS <= dur <= MAX_DURATION_BLOCKS):
            raise gl.vm.UserError(f"{ERR_PARAMS} duration out of range")
        if not (MIN_UPTIME_BPS <= up <= MAX_UPTIME_BPS):
            raise gl.vm.UserError(f"{ERR_PARAMS} min_uptime_bps out of range")
        if not (MIN_INTERVAL_BLOCKS <= interval <= MAX_INTERVAL_BLOCKS):
            raise gl.vm.UserError(f"{ERR_PARAMS} probe interval out of range")
        min_blocks = _min_duration_blocks(up, interval, int(self.claim_grace))
        if dur < min_blocks:
            raise gl.vm.UserError(
                f"{ERR_PARAMS} term too short: this uptime target and probe interval need at least "
                f"{min_blocks} blocks for a claim to be establishable inside the term"
            )

        premium = _premium_for(cov, dur, up)
        paid = int(gl.message.value)
        if paid < premium:
            raise gl.vm.UserError(f"{ERR_EXPECTED} premium {premium} not covered by value {paid}")

        assets = int(self.pool_assets)
        locked = int(self.locked_coverage)
        apex = str(ep.apex)
        holder_hex = _hex(holder)
        host_now = int(self.host_exposure[apex]) if apex in self.host_exposure else 0
        holder_now = int(self.holder_exposure[holder_hex]) if holder_hex in self.holder_exposure else 0
        if cov > assets * MAX_POLICY_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} coverage exceeds per-policy cap of pool depth")
        if locked + cov > assets * MAX_UTILIZATION_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} pool utilization cap reached")
        if host_now + cov > assets * MAX_HOST_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} per-provider (registrable domain) exposure cap reached")
        if holder_now + cov > assets * MAX_HOLDER_BPS // BPS:
            raise gl.vm.UserError(f"{ERR_CAP} per-holder exposure cap reached")

        duration_secs = dur * BLOCK_SECONDS
        active_from = now + int(self.activation_delay)
        pid = int(self.next_policy_id)
        self.next_policy_id = pid + 1
        self.policies[pid] = Policy(
            holder=holder,
            endpoint_id=endpoint_id,
            endpoint_url=str(ep.url),
            host=str(ep.host),
            apex=apex,
            chain_id=int(ep.chain_id),
            min_uptime_bps=up,
            probe_interval=interval * BLOCK_SECONDS,
            coverage=cov,
            premium=premium,
            duration_secs=duration_secs,
            created_at=now,
            active_from=active_from,
            expires_at=active_from + duration_secs,
            status=ST_ACTIVE,
            window_started=active_from,
            downtime_secs=0,
            samples_total=0,
            samples_ok=0,
            inconclusive_rounds=0,
            consecutive_failures=0,
            last_fail_at=0,
            outage_started_at=0,
            outage_start_head=0,
            last_ref_head=0,
            baseline_ok=False,
            last_probe_at=0,
            last_block=0,
            last_reason="",
            last_ok=False,
            breach_at=0,
            settle_at=0,
            claim_count=0,
            payout=0,
            released=0,
            vest_start=0,
        )
        # effects
        self.locked_coverage = locked + cov
        self.host_exposure[apex] = host_now + cov
        self.holder_exposure[holder_hex] = holder_now + cov
        self.active_policies = int(self.active_policies) + 1
        self.annual_premium_run_rate = int(self.annual_premium_run_rate) + premium * YEAR_SECS // duration_secs
        self.pool_assets = assets + premium
        self.total_premiums = int(self.total_premiums) + premium
        self._log(pid, "POLICY_CREATED", f"{endpoint_id}: coverage {cov}, premium {premium}, {up} bps uptime")
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
        if p.status == ST_BREACH_PENDING and (now >= int(p.expires_at) or now > int(p.settle_at) + SETTLE_WINDOW):
            self._close(policy_id, ST_LAPSED)
            self._log(policy_id, "CLAIM_LAPSED", "staged claim not confirmed inside the policy term or settlement window")
            return ST_LAPSED
        raise gl.vm.UserError(f"{ERR_STATE} policy cannot be expired yet")

    # ----------------------------------------------------------------- probes
    @gl.public.write.payable
    def trigger_probe(self, policy_id: u256) -> dict:
        """Permissionless corroborated health round. Requires a spam bond:
        refunded when the round finds a corroborated failure or cannot be
        corroborated, forfeited to underwriters when it finds the endpoint
        healthy."""
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

        obs = self._consensus_round(p)
        verdict = str(obs["verdict"])

        # --- measurement window rollover (aligned to the policy's own clock) ---
        if now - int(p.window_started) >= MEASUREMENT_WINDOW:
            age = now - int(p.active_from)
            p.window_started = int(p.active_from) + (age // MEASUREMENT_WINDOW) * MEASUREMENT_WINDOW
            p.downtime_secs = 0
            p.samples_total = 0
            p.samples_ok = 0
        self.total_probes = int(self.total_probes) + 1
        p.last_probe_at = now
        p.last_reason = str(obs["reason"])
        p.last_ok = verdict == V_HEALTHY
        if int(obs["block"]) > 0:
            p.last_block = int(obs["block"])

        forfeit = 0
        staged = False
        if verdict == V_INCONCLUSIVE:
            # No baseline: neither a failure nor a recovery. Streak, downtime and
            # baseline are untouched and the bond is returned in full.
            p.inconclusive_rounds = int(p.inconclusive_rounds) + 1
        else:
            p.samples_total = int(p.samples_total) + 1
            p.last_ref_head = int(obs["ref_head"])
            if verdict == V_HEALTHY:
                p.samples_ok = int(p.samples_ok) + 1
                p.consecutive_failures = 0
                p.last_fail_at = 0
                p.outage_started_at = 0
                p.outage_start_head = 0
                p.baseline_ok = True
                forfeit = int(self.probe_bond)
                self.pool_assets = int(self.pool_assets) + forfeit
                self.total_bond_forfeits = int(self.total_bond_forfeits) + forfeit
            else:
                streak = int(p.consecutive_failures)
                if streak > 0 and now - int(p.last_fail_at) > MAX_PROBE_GAP_SECS:
                    streak = 0  # unobserved time: the earlier failures are not part of this outage
                if streak == 0:
                    p.outage_started_at = now
                    p.outage_start_head = int(obs["ref_head"])
                p.consecutive_failures = streak + 1
                p.last_fail_at = now
                p.downtime_secs = int(p.downtime_secs) + int(p.probe_interval)
            staged = self._maybe_stage_breach(policy_id, p, now, int(obs["ref_head"]))
        self._log(policy_id, "PROBE", _describe(obs), obs)
        self._pay(gl.message.sender_address, bond - forfeit)

        return {
            "ok": verdict == V_HEALTHY,
            "verdict": verdict,
            "reason": str(obs["reason"]),
            "status": int(obs["status"]),
            "block": int(obs["block"]),
            "ref_head": int(obs["ref_head"]),
            "refs_ok": int(obs["refs_ok"]),
            "refs_total": int(obs["refs_total"]),
            "breach_staged": staged,
            "consecutive_failures": int(p.consecutive_failures),
            "uptime_bps": self._uptime_bps(p, now),
        }

    @gl.public.write.payable
    def settle_claim(self, policy_id: u256) -> dict:
        """Re-verifies a staged breach after the grace period with a fresh
        corroborated round. If the endpoint is still FAILING the breach is
        CONFIRMED and the payout starts vesting (see `release_payout`); if it
        is HEALTHY the claim is dismissed and the policy resumes; an
        INCONCLUSIVE round changes nothing."""
        p = self._get(policy_id)
        if p.status != ST_BREACH_PENDING:
            raise gl.vm.UserError(f"{ERR_STATE} no staged claim on this policy")
        now = self._now()
        if now < int(p.settle_at):
            raise gl.vm.UserError(f"{ERR_TOO_SOON} claim grace period has not elapsed")
        if now > int(p.settle_at) + SETTLE_WINDOW:
            raise gl.vm.UserError(f"{ERR_STATE} claim lapsed; call expire_policy")
        if now >= int(p.expires_at):
            # No observation is accepted after the term: a claim must be confirmed
            # inside it, so a failure recorded later cannot revive a stale claim.
            raise gl.vm.UserError(f"{ERR_STATE} policy term has ended; the claim lapsed, call expire_policy")
        bond = int(gl.message.value)
        if bond < int(self.probe_bond):
            raise gl.vm.UserError(f"{ERR_EXPECTED} probe bond {int(self.probe_bond)} required")

        obs = self._consensus_round(p)
        verdict = str(obs["verdict"])
        if verdict == V_INCONCLUSIVE:
            raise gl.vm.UserError(f"{ERR_INCONCLUSIVE} re-verification could not be corroborated; retry")
        text = _describe(obs)
        coverage = int(p.coverage)

        if verdict == V_FAILING:
            # The age-ramp is frozen at the moment the breach was staged: waiting
            # to settle must not raise the payout.
            payout = _vested_payout(coverage, int(p.breach_at) - int(p.active_from))
            assets = int(self.pool_assets)
            if payout > assets:
                payout = assets  # bounded: can never exceed pool depth
            # Claim velocity ceiling: a wave of breaches is confirmed across
            # epochs. The claim stays staged (and the whole call reverts,
            # refunding the bond) until the next epoch has room; the 14-day
            # settlement window outlasts the queue. The first confirmation of an
            # epoch is always allowed (progress guarantee).
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
            p.payout = payout
            p.released = 0
            p.vest_start = now
            p.last_reason = str(obs["reason"])
            p.last_ok = False
            p.last_probe_at = now
            self._begin_vesting(policy_id, payout)
            self._log(
                policy_id,
                "BREACH_CONFIRMED_VESTING",
                f"re-verification confirmed breach ({text}); {payout} of {coverage} coverage vests "
                f"after a {PAYOUT_COOLDOWN_SECS}s cooldown over {PAYOUT_VEST_SECS}s",
                obs,
            )
            self._pay(gl.message.sender_address, bond)
            return {"confirmed": True, "payout": str(payout), "reason": str(obs["reason"]),
                    "vest_start": now, "releasable_from": now + PAYOUT_COOLDOWN_SECS,
                    "fully_vested_at": now + PAYOUT_COOLDOWN_SECS + PAYOUT_VEST_SECS}

        # Endpoint recovered during the grace period: dismiss, resume cover.
        self.total_probes = int(self.total_probes) + 1
        forfeit = int(self.probe_bond)
        self.pool_assets = int(self.pool_assets) + forfeit
        self.total_bond_forfeits = int(self.total_bond_forfeits) + forfeit
        self.reserved_payouts = int(self.reserved_payouts) - coverage
        p.status = ST_ACTIVE
        p.consecutive_failures = 0
        p.last_fail_at = 0
        p.outage_started_at = 0
        p.outage_start_head = 0
        p.last_ok = True
        p.last_reason = R_OK
        p.last_probe_at = now
        if int(obs["block"]) > 0:
            p.last_block = int(obs["block"])
        self._log(policy_id, "CLAIM_DISMISSED", f"endpoint recovered during grace period ({text})", obs)
        self._pay(gl.message.sender_address, bond - forfeit)
        return {"confirmed": False, "payout": "0", "reason": R_OK}

    @gl.public.write
    def release_payout(self, policy_id: u256) -> dict:
        """Permissionless. Pays the HOLDER the portion of a confirmed payout
        that has vested: nothing during the cooldown, then linearly."""
        p = self._get(policy_id)
        if p.status != ST_VESTING:
            raise gl.vm.UserError(f"{ERR_STATE} policy has no vesting payout")
        now = self._now()
        payout = int(p.payout)
        released = int(p.released)
        due = _releasable(payout, int(p.vest_start), now) - released
        if due <= 0:
            raise gl.vm.UserError(f"{ERR_TOO_SOON} nothing has vested yet")
        holder = p.holder
        p.released = released + due
        self.owed_payouts = int(self.owed_payouts) - due
        self.reserved_payouts = int(self.reserved_payouts) - due
        self.locked_coverage = int(self.locked_coverage) - due
        self.pool_assets = int(self.pool_assets) - due
        self.total_payouts = int(self.total_payouts) + due
        done = released + due >= payout
        if done:
            p.status = ST_PAID
        self._log(policy_id, "PAYOUT_RELEASED", f"released {due} ({released + due} of {payout})")
        self._pay(holder, due)
        return {"released": str(due), "total_released": str(released + due), "payout": str(payout), "done": done}

    # ---------------------------------------------------------------- internal
    def _only_governor(self) -> None:
        if gl.message.sender_address != self.governor:
            raise gl.vm.UserError(f"{ERR_UNAUTHORIZED} only the registry governor may do this")

    def _references(self, chain_id: int, apex: str) -> list:
        """Deterministic reference set for a chain: the first MAX_REFERENCES
        LISTED endpoints, in listing order, on the same chain and from distinct
        providers other than the insured one. A listing only becomes a
        reference after the same listing delay that gates insurability, so a
        just-listed (possibly hostile) endpoint cannot sway a round.
        Returns [(id, url)]."""
        out = []
        seen = {apex}
        now = self._now()
        for i in range(len(self.endpoint_ids)):
            if len(out) >= MAX_REFERENCES:
                break
            ep = self.endpoints[self.endpoint_ids[i]]
            if ep.status != EP_LISTED or int(ep.chain_id) != chain_id:
                continue
            if now < int(ep.listed_at) + LISTING_DELAY_SECS:
                continue
            ep_apex = str(ep.apex)
            if ep_apex in seen:
                continue
            seen.add(ep_apex)
            out.append((str(ep.endpoint_id), str(ep.url)))
        return out

    def _verify_chain_id(self, url: str) -> int:
        """Consensus `eth_chainId`: the leader and every validator must read the
        same chain id from the endpoint."""

        def leader() -> int:
            _, _, chain = _rpc_call(url, "eth_chainId")
            return chain

        def validator(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return False
            got = leaders_res.calldata
            if not isinstance(got, int) or isinstance(got, bool) or got <= 0:
                return False
            return got == leader()

        return gl.vm.run_nondet(leader, validator)

    def _consensus_round(self, p: Policy) -> dict:
        url = str(p.endpoint_url)
        refs = self._references(int(p.chain_id), str(p.apex))
        expected_ids = [rid for rid, _ in refs]

        def leader() -> dict:
            return _round(url, refs)

        def validator(leaders_res: gl.vm.Result) -> bool:
            return _round_agrees(leaders_res, leader, expected_ids)

        return gl.vm.run_nondet(leader, validator)

    def _withdrawable(self, value: int, free: int, total: int, locked: int) -> int:
        """Largest amount `withdraw_underwriting` will accept for a position:
        its value, the unlocked liquidity, and (while capital is locked) the
        MIN_TOTAL_SHARES floor on what remains."""
        cap = value if value < free else free
        if locked > 0 and total > 0:
            net = self._net_assets()
            room = (total - MIN_TOTAL_SHARES) * net // total if total > MIN_TOTAL_SHARES else 0
            if room < cap:
                cap = room
        return cap

    def _staged_reserved(self) -> int:
        reserved = int(self.reserved_payouts)
        owed = int(self.owed_payouts)
        return reserved - owed if reserved > owed else 0

    def _net_assets(self) -> int:
        """Pool assets net of capital reserved for staged claims and confirmed,
        unreleased payouts: the basis for share pricing and redemptions."""
        assets = int(self.pool_assets)
        reserved = int(self.reserved_payouts)
        return assets - reserved if assets > reserved else 0

    def _velocity_window(self, now: int, assets: int) -> tuple:
        """(paid so far this epoch, payout ceiling for this epoch)."""
        epoch = now // EPOCH_SECONDS
        if epoch == int(self.velocity_epoch) and int(self.velocity_base) > 0:
            return int(self.velocity_paid), int(self.velocity_base) * MAX_EPOCH_PAYOUT_BPS // BPS
        return 0, assets * MAX_EPOCH_PAYOUT_BPS // BPS

    def _uptime_bps(self, p: Policy, now: int) -> int:
        """Time-weighted uptime: each corroborated failing round counts one
        probe interval of downtime, against the elapsed window floored at
        MIN_UPTIME_WINDOW. Unprobed time counts as up (conservative for
        underwriters), and probing only during a failure cannot shrink the
        denominator, so the ratio does not depend on WHEN anyone chose to probe."""
        started = int(p.window_started)
        if now - started >= MEASUREMENT_WINDOW:
            return BPS  # a fresh window has recorded no downtime yet
        span = now - started
        if span < MIN_UPTIME_WINDOW:
            span = MIN_UPTIME_WINDOW
        down = int(p.downtime_secs) * BPS // span
        return BPS - down if down < BPS else 0

    def _maybe_stage_breach(self, pid: int, p: Policy, now: int, ref_head: int) -> bool:
        if int(p.consecutive_failures) < BREACH_CONSECUTIVE or not p.baseline_ok:
            return False
        started = int(p.outage_started_at)
        if started == 0 or now - started < MIN_OUTAGE_SECS:
            return False  # outage must persist across real elapsed time
        if ref_head - int(p.outage_start_head) < MIN_OUTAGE_BLOCKS:
            return False  # ...and across real chain progress observed by the references
        if self._uptime_bps(p, now) >= int(p.min_uptime_bps):
            return False
        if now + int(self.claim_grace) >= int(p.expires_at):
            return False  # its re-verification could not fall inside the term
        p.status = ST_BREACH_PENDING
        p.breach_at = now
        p.settle_at = now + int(self.claim_grace)
        p.claim_count = int(p.claim_count) + 1
        self.reserved_payouts = int(self.reserved_payouts) + int(p.coverage)
        self.total_breaches = int(self.total_breaches) + 1
        self._log(
            pid,
            "BREACH_STAGED",
            f"{int(p.consecutive_failures)} corroborated failing rounds over {now - started}s and "
            f"{ref_head - int(p.outage_start_head)} blocks; uptime {self._uptime_bps(p, now)} bps "
            f"< {int(p.min_uptime_bps)} bps SLA; payout reserved, grace until {int(p.settle_at)}",
        )
        return True

    def _release_exposure(self, p: Policy, cov: int) -> None:
        self.host_exposure[str(p.apex)] = int(self.host_exposure[str(p.apex)]) - cov
        holder_hex = _hex(p.holder)
        self.holder_exposure[holder_hex] = int(self.holder_exposure[holder_hex]) - cov
        self.active_policies = int(self.active_policies) - 1
        self.annual_premium_run_rate = int(self.annual_premium_run_rate) - int(p.premium) * YEAR_SECS // int(p.duration_secs)

    def _close(self, pid: int, status: str) -> None:
        """Move a live policy to a terminal state and release all its exposure."""
        p = self.policies[pid]
        cov = int(p.coverage)
        if p.status == ST_BREACH_PENDING:
            self.reserved_payouts = int(self.reserved_payouts) - cov
        self.locked_coverage = int(self.locked_coverage) - cov
        self._release_exposure(p, cov)
        p.status = status

    def _begin_vesting(self, pid: int, payout: int) -> None:
        """Breach confirmed: the policy stops insuring (exposure released), the
        un-paid slice of coverage returns to the pool, and the payout is parked
        as a certain, reserved liability until `release_payout` streams it out."""
        p = self.policies[pid]
        cov = int(p.coverage)
        self.reserved_payouts = int(self.reserved_payouts) - cov + payout
        self.owed_payouts = int(self.owed_payouts) + payout
        self.locked_coverage = int(self.locked_coverage) - cov + payout
        self._release_exposure(p, cov)
        p.status = ST_VESTING

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
            rec["verdict"] = str(obs["verdict"])
            rec["ok"] = str(obs["verdict"]) == V_HEALTHY
            rec["reason"] = str(obs["reason"])
            rec["status"] = int(obs["status"])
            rec["block"] = int(obs["block"])
            rec["ref_head"] = int(obs["ref_head"])
            rec["refs_ok"] = int(obs["refs_ok"])
            rec["refs_total"] = int(obs["refs_total"])
        self.incidents.append(json.dumps(rec, sort_keys=True))

    def _endpoint_dict(self, endpoint_id: str) -> dict:
        ep = self.endpoints[endpoint_id]
        listed_at = int(ep.listed_at)
        return {
            "endpoint_id": str(ep.endpoint_id),
            "provider": str(ep.provider),
            "domain": str(ep.domain),
            "url": str(ep.url),
            "host": str(ep.host),
            "apex": str(ep.apex),
            "chain_id": int(ep.chain_id),
            "attestation": str(ep.attestation),
            "listed_at": listed_at,
            "insurable_from": listed_at + LISTING_DELAY_SECS,
            "status": str(ep.status),
        }

    def _policy_dict(self, pid: int) -> dict:
        p = self.policies[pid]
        now = self._now()
        outage_blocks = 0
        if int(p.outage_started_at) > 0 and int(p.last_ref_head) > int(p.outage_start_head):
            outage_blocks = int(p.last_ref_head) - int(p.outage_start_head)
        payout = int(p.payout)
        releasable = 0
        if p.status == ST_VESTING:
            releasable = _releasable(payout, int(p.vest_start), now) - int(p.released)
        return {
            "id": int(pid),
            "holder": _hex(p.holder),
            "endpoint_id": str(p.endpoint_id),
            "endpoint_url": str(p.endpoint_url),
            "host": str(p.host),
            "apex": str(p.apex),
            "chain_id": int(p.chain_id),
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
            "inconclusive_rounds": int(p.inconclusive_rounds),
            "downtime_secs": int(p.downtime_secs),
            "uptime_bps": self._uptime_bps(p, now),
            "consecutive_failures": int(p.consecutive_failures),
            "outage_started_at": int(p.outage_started_at),
            "outage_blocks": outage_blocks,
            "baseline_ok": bool(p.baseline_ok),
            "last_probe_at": int(p.last_probe_at),
            "last_block": int(p.last_block),
            "last_ref_head": int(p.last_ref_head),
            "last_reason": str(p.last_reason),
            "last_ok": bool(p.last_ok),
            "breach_at": int(p.breach_at),
            "settle_at": int(p.settle_at),
            "claim_count": int(p.claim_count),
            "payout": str(payout),
            "released": str(int(p.released)),
            "releasable": str(releasable if releasable > 0 else 0),
            "vest_start": int(p.vest_start),
        }

    def _now(self) -> int:
        # Deterministic block clock: GenVM patches datetime.now() to the
        # transaction timestamp; the direct harness patches it for warp().
        return int(datetime.now(timezone.utc).timestamp())
