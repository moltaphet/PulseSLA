import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "PulseSLA — parametric infrastructure insurance",
  description: "Underwrite and buy parametric SLA cover for RPC nodes, indexers, bridges and sequencers. Breaches are detected and paid by GenLayer validator consensus.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
