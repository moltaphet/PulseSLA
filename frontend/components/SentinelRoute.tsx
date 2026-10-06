"use client";

import { useSearchParams } from "next/navigation";
import { Sentinel } from "./Sentinel";

/** Reads ?policy=<id> so the marketplace can deep-link a freshly minted policy. */
export function SentinelRoute() {
  const raw = useSearchParams().get("policy");
  const id = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return <Sentinel key={id ?? "none"} initialPolicyId={id} />;
}
