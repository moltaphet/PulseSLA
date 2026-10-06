#!/usr/bin/env python3
"""Live on-chain verification of a deployed PulseSLA contract.

    .venv/bin/python scripts/verify_live.py [--network studio-next] [--endpoint URL]

Steps (each asserted): deposit underwriting liquidity -> buy a small policy on a
real public RPC endpoint -> wait out the activation delay -> trigger a probe and
confirm GenVM web consensus decided it on-chain -> check solvency and status views.
Writes deployments/<network>-verification.json and stores the deploy receipt in
deployments/<network>.json.
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.common import DEPLOYMENTS, load_account, make_client, policy_fees  # noqa: E402

GEN = 10**18
OK_EXEC = "FINISHED_WITH_RETURN"


def jsonable(o):
    return json.loads(json.dumps(o, default=lambda x: x.hex() if isinstance(x, (bytes, bytearray)) else str(x)))


class Live:
    def __init__(self, network: str):
        self.record = json.loads((DEPLOYMENTS / f"{network}.json").read_text())
        self.address = self.record["contract_address"]
        self.account = load_account(create=False)
        self.client = make_client(network, self.account, self.record.get("rpc_url"))
        self.log: list[dict] = []

    def read(self, fn, *args):
        return self.client.read_contract(self.address, fn, args=list(args))

    def write(self, fn, *args, value=0):
        t0 = time.time()
        h = self.client.write_contract(self.address, fn, args=list(args), value=value, fees=policy_fees(self.client))
        r = self.client.wait_for_transaction_receipt(h, wait_until="decided", interval=4, retries=150)
        tx = self.client.get_transaction(h)
        ex = r.get("txExecutionResultName") or r.get("tx_execution_result_name")
        entry = {"fn": fn, "tx": str(h), "execution": ex, "consensus": r.get("result_name"),
                 "votes": (tx.get("consensus_data") or {}).get("votes"), "seconds": round(time.time() - t0, 1)}
        self.log.append(entry)
        print(f"    {fn}: tx {str(h)[:18]}… execution={ex} consensus={entry['consensus']} ({entry['seconds']}s)")
        return entry, r, tx


def step(msg):
    print(f"\n=== {msg}")


def check(label, ok, detail=""):
    print(f"    [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        raise SystemExit(f"verification failed: {label}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--network", default="studio-next")
    ap.add_argument("--endpoint", default="https://ethereum-rpc.publicnode.com")
    ap.add_argument("--deposit-gen", type=float, default=1.0)
    ap.add_argument("--coverage-gen", type=float, default=0.05)
    a = ap.parse_args()
    L = Live(a.network)
    me = L.account.address.lower()
    print(f"contract {L.address}\nsender   {me}")

    step("0. Contract is live and configured")
    m0 = L.read("get_pool_metrics")
    print("   ", {k: m0[k] for k in ("tvl", "activation_delay", "claim_grace", "probe_bond", "solvent")})
    check("solvent, empty or seeded pool", m0["solvent"] is True)
    check("hardened build: net-asset pricing and claim-velocity fields present",
          all(k in m0 for k in ("net_assets", "epoch_ceiling", "epoch_paid")) and m0["max_epoch_payout_bps"] == 3000,
          f"max_epoch_payout_bps={m0.get('max_epoch_payout_bps')}")
    delay, bond = int(m0["activation_delay"]), int(m0["probe_bond"])

    step("a. Deposit underwriting liquidity")
    dep = int(a.deposit_gen * GEN)
    e, r, _ = L.write("deposit_underwriting", value=dep)
    check("deposit executed", e["execution"] == OK_EXEC and e["consensus"] == "MAJORITY_AGREE")
    m1 = L.read("get_pool_metrics")
    check("TVL increased by the deposit", int(m1["tvl"]) == int(m0["tvl"]) + dep, f"tvl {int(m1['tvl']) / GEN} GEN")
    pos = L.read("get_underwriter", me)
    check("underwriter position recorded", int(pos["shares"]) > 0, f"value {int(pos['value']) / GEN} GEN")

    step("b. Buy a live policy on a real public endpoint")
    cov = int(a.coverage_gen * GEN)
    blocks, uptime = 300, 9900
    premium = int(L.read("quote_premium", cov, blocks, uptime))
    e, r, _ = L.write("create_policy", a.endpoint, 3000, cov, blocks, uptime, 5, "rpc", value=premium)
    check("policy created", e["execution"] == OK_EXEC and e["consensus"] == "MAJORITY_AGREE")
    pid = int(L.read("get_policy_count"))
    p = L.read("get_policy_status", pid)
    check("policy is ACTIVE with the quoted premium", p["status"] == "ACTIVE" and int(p["premium"]) == premium, f"policy #{pid}, premium {premium / GEN} GEN")
    check("exposure is keyed by registrable domain", p.get("apex") == "publicnode.com", f"apex={p.get('apex')}")
    check("coverage locked in the pool", int(L.read("get_pool_metrics")["locked_coverage"]) >= cov)

    step(f"c. Wait for activation ({delay}s), then probe {a.endpoint} through GenVM consensus")
    wait = max(0, int(p["active_from"]) - int(time.time())) + 15
    print(f"    sleeping {wait}s")
    time.sleep(wait)
    for attempt in range(1, 4):
        try:
            e, r, tx = L.write("trigger_probe", pid, value=bond)
        except Exception as exc:  # activation uses chain time; allow a couple of retries
            print(f"    attempt {attempt} raised: {str(exc)[:160]}")
            time.sleep(30)
            continue
        p = L.read("get_policy_status", pid)
        if p["samples_total"] >= 1:
            break
        print(f"    attempt {attempt}: no sample recorded (execution={e['execution']}); retrying in 30s")
        time.sleep(30)
    check("probe executed and reached validator consensus", e["execution"] == OK_EXEC and e["consensus"] == "MAJORITY_AGREE")
    if e["votes"]:
        agree = sum(1 for v in e["votes"].values() if "AGREE" in str(v).upper() and "DIS" not in str(v).upper())
        print(f"    validator votes: {agree}/{len(e['votes'])} agree  {e['votes']}")
    check("probe was recorded on-chain", int(p["samples_total"]) == 1, f"reason={p['last_reason']} ok={p['last_ok']} latency={p['last_latency_ms']}ms block={p['last_block']}")
    incidents = [json.loads(s) for s in L.read("get_incidents", 0, 50)]
    probe = [i for i in incidents if i["kind"] == "PROBE" and i["policy_id"] == pid]
    check("PROBE incident logged with a verdict", len(probe) == 1 and "ok" in probe[0], probe[0]["detail"] if probe else "")
    if p["last_ok"]:
        check("healthy endpoint: baseline established", p["baseline_ok"] is True and int(p["last_block"]) > 0)

    step("d. Solvency and status queries")
    m = L.read("get_pool_metrics")
    check("pool solvent (locked <= assets)", m["solvent"] is True and int(m["locked_coverage"]) <= int(m["tvl"]),
          f"tvl {int(m['tvl']) / GEN} GEN, locked {int(m['locked_coverage']) / GEN} GEN, util {m['utilization_bps'] / 100:.2f}%")
    check("net assets equal gross assets with nothing reserved", m["net_assets"] == m["tvl"] and m["reserved_payouts"] == "0")
    check("probe counter advanced", int(m["total_probes"]) >= 1)
    check("policy status query is consistent", L.read("get_policy_status", pid)["id"] == pid and int(L.read("get_policy_count")) >= 1)
    lst = L.read("list_policies", 0, 10)
    check("list_policies returns the policy", any(int(x["id"]) == pid for x in lst))

    out = DEPLOYMENTS / f"{a.network}-verification.json"
    out.write_text(json.dumps(jsonable({"contract": L.address, "sender": me, "endpoint": a.endpoint, "policy_id": pid,
                                        "transactions": L.log, "final_metrics": m, "policy": L.read("get_policy_status", pid)}), indent=2) + "\n")
    # keep the deploy receipt next to the address
    rec = L.record
    if "deploy_receipt" not in rec and rec.get("deploy_tx"):
        try:
            rec["deploy_receipt"] = jsonable(L.client.get_transaction(rec["deploy_tx"]))
            (DEPLOYMENTS / f"{a.network}.json").write_text(json.dumps(rec, indent=2) + "\n")
        except Exception as exc:
            print(f"    (could not fetch deploy receipt: {exc})")
    print(f"\nLIVE VERIFICATION OK -> {out.relative_to(DEPLOYMENTS.parent)}")


if __name__ == "__main__":
    main()
