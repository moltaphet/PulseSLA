#!/usr/bin/env python3
"""Populate the authenticated infrastructure registry of a deployed PulseSLA.

    .venv/bin/python scripts/register_endpoints.py [--network studio-next] [--dry-run]

Run by the registry GOVERNOR (the deployer key). For every provider in the
manifest below it recomputes the commitment hash, asks the contract to confirm it
(`compute_attestation`), then calls `register_endpoint`, which authenticates the
endpoint on-chain by consensus (`eth_chainId` must equal the declared chain).

Manifest rules (enforced by the contract, not just by this script):
  * public, KEYLESS https JSON-RPC URL under the provider's registrable domain
    (an API key in the URL is a secret and must never go on-chain);
  * at least four independent provider domains per chain, so each insured
    endpoint is corroborated by three references from other providers;
  * a listing becomes insurable AND counts as a reference only after the
    24-hour listing delay.

Infura, Alchemy and Ankr currently require an API key for Ethereum mainnet, so
they are not in the default manifest; list them if/when they publish a keyless
gateway. Edit PROVIDERS to curate a different set.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.common import DEPLOYMENTS, TxNotSuccessful, assess_receipt, load_account, make_client, policy_fees  # noqa: E402

CHAIN_ID = 1
# (endpoint_id, provider, registrable domain, keyless url)
PROVIDERS = [
    ("publicnode-eth", "PublicNode", "publicnode.com", "https://ethereum-rpc.publicnode.com"),
    ("cloudflare-eth", "Cloudflare", "cloudflare-eth.com", "https://cloudflare-eth.com"),
    ("drpc-eth", "dRPC", "drpc.org", "https://eth.drpc.org"),
    ("tenderly-eth", "Tenderly", "tenderly.co", "https://mainnet.gateway.tenderly.co"),
    ("flashbots-eth", "Flashbots", "flashbots.net", "https://rpc.flashbots.net"),
]
# Tried and rejected: 1RPC (https://1rpc.io/eth) answered from a developer machine but the Studio Next validators
# did not reach consensus on its eth_chainId (MAJORITY_DISAGREE), so it is not a usable listing there.


def attestation(endpoint_id: str, provider: str, domain: str, chain_id: int, url: str) -> str:
    """Must match contracts/uptime_sla.py::_attestation."""
    return hashlib.sha256(f"pulsesla/v1|{endpoint_id}|{provider}|{domain}|{chain_id}|{url}".encode()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="studio-next")
    ap.add_argument("--dry-run", action="store_true", help="print the manifest and commitments; send nothing")
    ap.add_argument("--skip-reads", action="store_true",
                    help="do not read the contract (Studio Next's gen_call can fail for every contract): the governor "
                         "is the deployer recorded in the deployment file, and commitments are computed locally")
    a = ap.parse_args()

    record = json.loads((DEPLOYMENTS / f"{a.network}.json").read_text())
    address = record["contract_address"]
    account = load_account(create=False)
    client = make_client(a.network, account, record.get("rpc_url"))
    gov = record["deployer"] if a.skip_reads else client.read_contract(address, "get_governor", args=[])
    print(f"contract {address}\ngovernor {gov}\nsender   {account.address.lower()}")
    if not a.dry_run and gov.lower() != account.address.lower():
        raise SystemExit("this key is not the registry governor")

    listed = set() if a.skip_reads else {e["endpoint_id"] for e in client.read_contract(address, "list_endpoints", args=[0, 50])}
    for endpoint_id, provider, domain, url in PROVIDERS:
        att = attestation(endpoint_id, provider, domain, CHAIN_ID, url)
        if not a.skip_reads:
            on_chain = client.read_contract(address, "compute_attestation", args=[endpoint_id, provider, domain, CHAIN_ID, url])
            assert on_chain == att, f"commitment mismatch for {endpoint_id}: {on_chain} != {att}"
        print(f"  {endpoint_id:<16} {provider:<12} {url:<42} sha256 {att[:16]}…")
        if endpoint_id in listed:
            print("    already listed")
            continue
        if a.dry_run:
            continue
        h = client.write_contract(address, "register_endpoint", args=[endpoint_id, provider, domain, CHAIN_ID, url, att],
                                  value=0, fees=policy_fees(client))
        r = client.wait_for_transaction_receipt(h, wait_until="decided", interval=4, retries=150)
        try:
            ok = assess_receipt(r, client.get_transaction(h))
        except TxNotSuccessful as exc:
            raise SystemExit(f"registration of {endpoint_id} failed: {exc}")
        print(f"    registered: tx {str(h)[:18]}… status={ok['status']} execution={ok['execution']} consensus={ok['consensus']}")
    if not a.dry_run:
        print("\nlistings become insurable (and become references) after the 24 h listing delay")


if __name__ == "__main__":
    main()
