"use client";

import { useState } from "react";
import { isDemoClient } from "@/lib/chain/demo";
import type { EndpointMode } from "@/lib/sim/engine";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { Button } from "./ui";

const MODES: { value: EndpointMode; label: string }[] = [
  { value: "healthy", label: "Healthy" },
  { value: "slow", label: "High latency" },
  { value: "http502", label: "HTTP 502" },
  { value: "http504", label: "HTTP 504" },
  { value: "frozen", label: "Frozen block" },
  { value: "badpayload", label: "Bad payload" },
  { value: "down", label: "Unreachable" },
];
const JUMPS = [
  { label: "+1 min", s: 61 },
  { label: "+1 h", s: 3600 },
  { label: "+1 day", s: 86_400 },
  { label: "+8 days", s: 8 * 86_400 },
];

/** Demo mode only: script the world (time, endpoint health) so the whole outage -> payout flow can be driven from the UI. */
export function DemoControls() {
  const { client, refresh, now } = useProtocol();
  const [open, setOpen] = useState(false);
  if (!isDemoClient(client)) return null;
  const endpoints = client.endpointModes();

  return (
    <aside aria-label="Simulation controls" className="fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))]">
      <div className="rounded-xl border border-warn/40 bg-panel shadow-2xl shadow-black/50">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-warn">
          <span>Simulation controls</span>
          <span aria-hidden>{open ? "–" : "+"}</span>
        </button>
        {open && (
          <div className="space-y-4 border-t border-line px-4 py-4">
            <p className="text-xs text-muted">
              Simulated clock: <span className="num text-ink">{new Date(now * 1000).toISOString().slice(0, 16).replace("T", " ")}Z</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {JUMPS.map((j) => (
                <Button key={j.label} variant="ghost" className="!px-3 !py-1.5 text-xs" onClick={() => { client.advance(j.s); void refresh(); }}>
                  {j.label}
                </Button>
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Endpoint health</p>
              {endpoints.map((e) => (
                <label key={e.host} className="flex items-center justify-between gap-3 text-xs">
                  <span className="num truncate text-muted">{e.host}</span>
                  <select value={e.mode} aria-label={`Health of ${e.host}`}
                    onChange={(ev) => { client.setEndpoint(e.host, ev.target.value as EndpointMode); void refresh(); }}
                    className="rounded-md border border-line bg-bg px-2 py-1 text-xs text-ink">
                    {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="text-xs text-zinc-400">Try it: break an endpoint, advance 1 min, probe it three times from the Sentinel, advance past the grace period, then settle the claim.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
