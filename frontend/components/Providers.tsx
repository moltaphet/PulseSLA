"use client";

import type { ReactNode } from "react";
import { ProtocolProvider } from "@/lib/hooks/useProtocol";
import { AppShell } from "./AppShell";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ProtocolProvider>
      <AppShell>{children}</AppShell>
    </ProtocolProvider>
  );
}
