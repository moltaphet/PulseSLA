"""Shared helpers for the PulseSLA deploy / interaction scripts."""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "uptime_sla.py"
DEPLOYMENTS = ROOT / "deployments"
KEY_DIR = ROOT / ".keys"
FRONTEND_GENERATED = ROOT / "frontend" / "lib" / "generated"

NETWORKS = {
    # name: (chain attribute in genlayer_py.chains, rpc url, explorer base)
    "studio-next": ("studio_devnet", "https://studio-next.genlayer.com/api",
                    "https://explorer-studio-next.genlayer.com"),
    "localnet": ("localnet", "http://127.0.0.1:4000/api", ""),
}

# Constructor defaults: a one-hour activation delay and a one-hour claim grace.
DEFAULT_ACTIVATION_SECS = 3600
DEFAULT_GRACE_SECS = 3600
DEFAULT_PROBE_BOND = 10**16  # 0.01 GEN


def run_lint() -> None:
    """`genvm-lint check` must pass before anything is deployed."""
    exe = Path(sys.executable).with_name("genvm-lint")
    out = subprocess.run([str(exe), "check", str(CONTRACT)], capture_output=True, text=True)
    print(out.stdout.strip())
    if out.returncode != 0:
        print(out.stderr.strip(), file=sys.stderr)
        raise SystemExit("genvm-lint failed: refusing to deploy")


def load_schema() -> dict:
    """The contract's real ABI as reported by the linter (`genvm-lint schema`)."""
    exe = Path(sys.executable).with_name("genvm-lint")
    out = subprocess.run([str(exe), "schema", str(CONTRACT), "--json"], capture_output=True, text=True)
    data = json.loads(out.stdout)
    if not data.get("ok"):
        raise SystemExit(f"could not extract schema: {data}")
    return data["schema"]


def abi_from_schema(schema: dict) -> list[dict]:
    """Flatten the linter schema into the list the frontend consumes."""
    methods = []
    for name, m in sorted(schema["methods"].items()):
        methods.append({
            "name": name,
            "inputs": [{"name": n, "type": t} for n, t in m["params"]],
            "readonly": bool(m["readonly"]),
            "payable": bool(m.get("payable", False)),
            "returns": m.get("ret"),
        })
    return methods


def load_account(path: Path | None = None, create: bool = True):
    """Deployer key: $PULSESLA_PRIVATE_KEY, else .keys/deployer.key.json (0600)."""
    from genlayer_py import create_account

    env_key = os.environ.get("PULSESLA_PRIVATE_KEY")
    if env_key:
        return create_account(env_key if env_key.startswith("0x") else "0x" + env_key)
    path = path or KEY_DIR / "deployer.key.json"
    if path.exists():
        key = json.loads(path.read_text())["private_key"]
        return create_account(key if key.startswith("0x") else "0x" + key)
    if not create:
        raise SystemExit(f"no key at {path}")
    KEY_DIR.mkdir(exist_ok=True)
    account = create_account()
    path.write_text(json.dumps({"private_key": account.key.hex()}, indent=2))
    os.chmod(path, 0o600)
    print(f"created new deployer key at {path}")
    return account


def make_client(network: str, account, rpc_url: str | None = None):
    from genlayer_py import create_client
    from genlayer_py import chains

    chain_attr, default_url, _ = NETWORKS[network]
    return create_client(chain=getattr(chains, chain_attr), endpoint=rpc_url or default_url, account=account)


def policy_fees(client) -> dict:
    """Fee options derived from the live fee policy, without simulating the call.

    Studio Next has no FeeManager contract and the SDK would otherwise send a
    zero deposit, which the chain rejects; deriving it from the policy avoids
    both that and a simulation that runs against a non-block clock."""
    from genlayer_py.contracts.actions import (
        _estimate_transaction_fees_with_policy,
        get_current_fee_policy,
    )

    est = _estimate_transaction_fees_with_policy(client, None, get_current_fee_policy(client))
    fees = {"distribution": est["distribution"], "feeValue": est.get("feeValue") or est.get("fee_value") or 0}
    if est.get("messageAllocations") is not None:
        fees["messageAllocations"] = est["messageAllocations"]
    return fees
