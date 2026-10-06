#!/usr/bin/env python3
"""Deploy contracts/uptime_sla.py to GenLayer Studio Next and export its address + ABI.

    .venv/bin/python scripts/deploy.py                 # deploy to studio-next
    .venv/bin/python scripts/deploy.py --dry-run       # lint + export ABI only, no transaction
    .venv/bin/python scripts/deploy.py --network localnet

Outputs
    deployments/<network>.json                  address, tx hash, constructor args, ABI
    deployments/abi.json                        the ABI on its own
    frontend/lib/generated/deployment.json      read by the dashboard at build time
    frontend/lib/generated/abi.json

The deployer key comes from $PULSESLA_PRIVATE_KEY or .keys/deployer.key.json
(created on first run, mode 0600, git-ignored). On a Studio network an unfunded
deployer is topped up from the network faucet.
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.common import (
    CONTRACT, DEFAULT_ACTIVATION_SECS, DEFAULT_GRACE_SECS, DEFAULT_PROBE_BOND, DEPLOYMENTS,
    FRONTEND_GENERATED, NETWORKS, ROOT, abi_from_schema, load_account, load_schema, make_client,
    policy_fees, run_lint,
)

MIN_BALANCE_WEI = 5 * 10**18


def _contract_address(receipt: dict, tx: dict) -> str | None:
    """Where the new address lands depends on the network: the simulator puts it
    on receipt.data, hosted chains on the decoded transaction data / recipient."""
    candidates = [
        (tx.get("data") or {}).get("contract_address") if isinstance(tx.get("data"), dict) else None,
        (receipt.get("data") or {}).get("contract_address") if isinstance(receipt.get("data"), dict) else None,
        tx.get("to_address"), tx.get("recipient"),
        receipt.get("contract_address"), receipt.get("to_address"),
    ]
    for c in candidates:
        if isinstance(c, str) and c.startswith("0x") and len(c) == 42 and int(c, 16) != 0:
            return c
    return None


def export(network: str, record: dict, abi: list[dict]) -> None:
    DEPLOYMENTS.mkdir(exist_ok=True)
    FRONTEND_GENERATED.mkdir(parents=True, exist_ok=True)
    (DEPLOYMENTS / f"{network}.json").write_text(json.dumps({**record, "abi": abi}, indent=2) + "\n")
    (DEPLOYMENTS / "abi.json").write_text(json.dumps(abi, indent=2) + "\n")
    (FRONTEND_GENERATED / "abi.json").write_text(json.dumps(abi, indent=2) + "\n")
    (FRONTEND_GENERATED / "deployment.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"exported ABI + deployment record -> {DEPLOYMENTS.relative_to(ROOT)}/ and frontend/lib/generated/")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", choices=sorted(NETWORKS), default="studio-next")
    ap.add_argument("--rpc-url")
    ap.add_argument("--activation-secs", type=int, default=DEFAULT_ACTIVATION_SECS)
    ap.add_argument("--grace-secs", type=int, default=DEFAULT_GRACE_SECS)
    ap.add_argument("--probe-bond", type=int, default=DEFAULT_PROBE_BOND, help="wei (atto-GEN)")
    ap.add_argument("--dry-run", action="store_true", help="lint and export the ABI; send nothing")
    args = ap.parse_args()

    run_lint()
    abi = abi_from_schema(load_schema())
    code = CONTRACT.read_text()
    ctor = [args.activation_secs, args.grace_secs, args.probe_bond]
    chain_attr, default_url, explorer = NETWORKS[args.network]
    rpc = args.rpc_url or default_url
    record = {
        "network": args.network,
        "rpc_url": rpc,
        "contract_address": None,
        "source": "contracts/uptime_sla.py",
        "source_sha256": hashlib.sha256(code.encode()).hexdigest(),
        "constructor_args": {
            "activation_delay_secs": ctor[0], "claim_grace_secs": ctor[1], "probe_bond": str(ctor[2]),
        },
        "deployed_at": None,
    }

    if args.dry_run:
        export(args.network, record, abi)
        print("dry run: nothing was sent to the network")
        return

    account = load_account()
    client = make_client(args.network, account, args.rpc_url)
    print(f"deployer {account.address} on {args.network} ({rpc})")

    bal = int(client.provider.make_request("eth_getBalance", [account.address, "latest"]).get("result", "0x0"), 16)
    if bal < MIN_BALANCE_WEI:
        if args.network == "localnet" or args.network.startswith("studio"):
            print("balance low -> requesting faucet top-up")
            client.fund_account(account.address, MIN_BALANCE_WEI - bal + 1)
        else:
            raise SystemExit(f"deployer {account.address} needs funding")

    tx_hash = client.deploy_contract(code=code, args=ctor, fees=policy_fees(client))
    print(f"deploy tx {tx_hash} -> waiting for consensus...")
    receipt = client.wait_for_transaction_receipt(tx_hash, wait_until="decided", interval=4, retries=120)
    tx = client.get_transaction(tx_hash)
    status = receipt.get("txExecutionResultName") or receipt.get("tx_execution_result_name")
    if status not in (None, "FINISHED_WITH_RETURN"):
        raise SystemExit(f"deployment failed: {status}\n{json.dumps(receipt, default=str)[:1500]}")
    address = _contract_address(receipt, tx)
    if address is None:
        raise SystemExit(f"deployed, but no contract address found in receipt:\n{json.dumps(receipt, default=str)[:1500]}")

    record.update(
        contract_address=address,
        deploy_tx=str(tx_hash),
        deployer=account.address,
        deployed_at=int(time.time()),
        explorer_url=f"{explorer}/address/{address}" if explorer else None,
    )
    export(args.network, record, abi)
    print(f"PulseSLA deployed at {address}")
    if record["explorer_url"]:
        print(record["explorer_url"])


if __name__ == "__main__":
    main()
