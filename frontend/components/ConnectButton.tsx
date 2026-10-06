"use client";

import { useProtocol } from "@/lib/hooks/useProtocol";
import { shortAddress } from "@/lib/units";
import { NETWORK_LABEL } from "@/lib/config";
import { Button } from "./ui";

export function ConnectButton() {
  const { mode, wallet, account } = useProtocol();

  if (mode === "demo") {
    return (
      <span className="num rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" title="Demo account (simulated funds)">
        {account ? shortAddress(account) : "demo"}
      </span>
    );
  }
  if (wallet.status === "unavailable") {
    return <Button variant="ghost" disabled title="Install an EIP-1193 browser wallet to transact">No wallet detected</Button>;
  }
  if (wallet.status === "connected" && wallet.wrongNetwork) {
    return <Button variant="danger" onClick={() => void wallet.switchNetwork()}>Switch to {NETWORK_LABEL}</Button>;
  }
  if (wallet.status === "connected" && wallet.account) {
    return (
      <div className="flex items-center gap-2">
        <span className="num rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink">{shortAddress(wallet.account)}</span>
        <Button variant="ghost" className="!px-3 !py-2 text-xs" onClick={wallet.disconnect}>Disconnect</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end">
      <Button loading={wallet.status === "connecting"} onClick={() => void wallet.connect()}>Connect wallet</Button>
      {wallet.error && <span role="alert" className="mt-1 max-w-64 text-right text-xs text-danger">{wallet.error}</span>}
    </div>
  );
}
