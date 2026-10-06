import { Suspense } from "react";
import { SentinelRoute } from "@/components/SentinelRoute";

export const metadata = { title: "Sentinel · PulseSLA" };

export default function Page() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <SentinelRoute />
    </Suspense>
  );
}
