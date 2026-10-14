#!/usr/bin/env python3
"""Export contract-computed premium quotes for the frontend's parity test.

    .venv/bin/python scripts/export_parity.py

Writes frontend/lib/__fixtures__/premium-parity.json and min-duration-parity.json.
The TypeScript `quotePremium` and `minDurationBlocks` must reproduce every row
exactly; the vitest suite asserts it, so a pricing or term-rule change in the
contract that is not mirrored in the UI fails the build.
"""

import itertools
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

GEN = 10**18


def main() -> None:
    from gltest.direct.loader import create_address, deploy_contract
    from gltest.direct.vm import VMContext

    vm = VMContext()
    vm.sender = create_address("deployer")
    rows = []
    with vm.activate():
        c = deploy_contract(ROOT / "contracts" / "uptime_sla.py", vm, 3600, 3600, 10**16)
        coverages = [10**15, 10**15 + 7, GEN, 3 * GEN + 12345, 8 * GEN, 250 * GEN]
        durations = [300, 5_000, 100_000, 432_000, 2_628_000]
        uptimes = [9000, 9500, 9900, 9950, 9990, 9999]
        for cov, dur, up in itertools.product(coverages, durations, uptimes):
            rows.append({"coverage": str(cov), "blocks": dur, "uptime_bps": up, "premium": c.quote_premium(cov, dur, up)})
    out = ROOT / "frontend" / "lib" / "__fixtures__" / "premium-parity.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(rows, indent=1) + "\n")
    print(f"wrote {len(rows)} rows -> {out.relative_to(ROOT)}")

    # Shortest insurable term per (claim grace, uptime target, probe interval).
    term_rows = []
    for grace in (300, 600, 3600):
        vm = VMContext()
        vm.sender = create_address("deployer")
        with vm.activate():
            c = deploy_contract(ROOT / "contracts" / "uptime_sla.py", vm, 3600, grace, 10**16)
            for up, interval in itertools.product((9000, 9500, 9900, 9950, 9990, 9999), (5, 15, 25, 60, 100, 150)):
                term_rows.append({
                    "claim_grace": grace, "uptime_bps": up, "interval_blocks": interval,
                    "min_blocks": int(c.min_insurable_duration(up, interval)),
                })
    out = ROOT / "frontend" / "lib" / "__fixtures__" / "min-duration-parity.json"
    out.write_text(json.dumps(term_rows, indent=1) + "\n")
    print(f"wrote {len(term_rows)} rows -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
