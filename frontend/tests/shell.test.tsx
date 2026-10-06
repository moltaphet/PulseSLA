import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { ConnectButton } from "@/components/ConnectButton";
import { TxBanner } from "@/components/TxBanner";
import { DemoClient } from "@/lib/chain/demo";
import { useProtocol } from "@/lib/hooks/useProtocol";
import { fakeWallet, makeDemo, renderWithProtocol } from "./utils";

let pathname = "/marketplace";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useSearchParams: () => new URLSearchParams() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

/** A demo-backed client that identifies as live, so the wallet drives the acting account. */
function liveStub(): DemoClient {
  const c = makeDemo();
  Object.defineProperty(c, "mode", { value: "live" });
  return c;
}

describe("ConnectButton", () => {
  it("demo mode shows the simulated account instead of a wallet", async () => {
    renderWithProtocol(<ConnectButton />);
    expect(await screen.findByTitle(/Demo account/)).toHaveTextContent("0xde51…0001");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("live mode without a wallet is disabled", async () => {
    renderWithProtocol(<ConnectButton />, { client: liveStub(), walletProvider: null });
    expect(await screen.findByRole("button", { name: /No wallet detected/ })).toBeDisabled();
  });

  it("connects, shows the short address, and disconnects", async () => {
    const user = userEvent.setup();
    const w = fakeWallet();
    renderWithProtocol(<ConnectButton />, { client: liveStub(), walletProvider: w.provider });
    await user.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByText("0xabc0…0001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  });

  it("shows a rejected connection", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<ConnectButton />, { client: liveStub(), walletProvider: fakeWallet({ rejectConnect: true }).provider });
    await user.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected/i);
  });

  it("offers a network switch on the wrong chain", async () => {
    const user = userEvent.setup();
    const w = fakeWallet({ accounts: ["0xAAA0000000000000000000000000000000000002"], chainId: "0x1" });
    renderWithProtocol(<ConnectButton />, { client: liveStub(), walletProvider: w.provider });
    const btn = await screen.findByRole("button", { name: /Switch to GenLayer Studio Next/ });
    await user.click(btn);
    expect(w.calls).toContain("wallet_switchEthereumChain");
  });
});

function Harness() {
  const p = useProtocol();
  return (
    <div>
      <button onClick={() => void p.settleClaim(1)}>bad-settle</button>
      <button onClick={() => void p.deposit(5n * 10n ** 18n)}>good-deposit</button>
      <button onClick={() => void p.triggerProbe(1)}>early-probe</button>
      <span data-testid="phase">{p.tx.phase}</span>
    </div>
  );
}

describe("TxBanner and protocol actions", () => {
  it("surfaces contract reverts with their error code", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<><TxBanner /><Harness /></>);
    await user.click(await screen.findByRole("button", { name: "bad-settle" }));
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Settle claim on policy #1");
    expect(banner).toHaveTextContent("[INVALID_STATE] no staged claim on this policy");
    await user.click(within(banner).getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports success and clears on dismiss", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<><TxBanner /><Harness /></>);
    await user.click(await screen.findByRole("button", { name: "good-deposit" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Deposit underwriting capital");
    expect(screen.getByTestId("phase")).toHaveTextContent("success");
  });

  it("reports a rejected probe", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<><TxBanner /><Harness /></>);
    await user.click(await screen.findByRole("button", { name: "early-probe" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/\[TOO_SOON\]/);
  });

  it("shows validator agreement and the outcome for a probe", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    client.advance(3 * 3600);
    renderWithProtocol(<><TxBanner /><Harness /></>, { client });
    await user.click(await screen.findByRole("button", { name: "early-probe" }));
    const banner = await screen.findByRole("status");
    await waitFor(() => expect(banner).toHaveTextContent(/validators agreed/));
    expect(banner).toHaveTextContent(/endpoint healthy/);
  });
});

describe("AppShell", () => {
  it("renders navigation with the active page, the demo badge and simulation controls", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    renderWithProtocol(<AppShell><p>page body</p></AppShell>, { client });
    expect(screen.getByText("page body")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Marketplace" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Underwrite" })).not.toHaveAttribute("aria-current");
    expect(within(nav).getAllByRole("link")).toHaveLength(5);
    expect(within(nav).getByRole("link", { name: "About" })).toHaveAttribute("href", "/about");
    expect(screen.getByText(/Demo · simulated protocol/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Simulation controls/ }));
    const select = screen.getByLabelText("Health of rpc.helios-node.io");
    await user.selectOptions(select, "http502");
    expect(client.sim.endpoints.get("rpc.helios-node.io")?.mode).toBe("http502");
    const before = client.now;
    await user.click(screen.getByRole("button", { name: "+1 h" }));
    expect(client.now).toBe(before + 3600);
  });

  it("home is active on '/' only", () => {
    pathname = "/";
    renderWithProtocol(<AppShell><p /></AppShell>);
    expect(screen.getByRole("link", { name: "Underwrite" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Marketplace" })).not.toHaveAttribute("aria-current");
    pathname = "/marketplace";
  });

  it("surfaces a protocol read failure", async () => {
    const client = makeDemo();
    client.getPoolMetrics = async () => { throw new Error("[RPC] node unreachable"); };
    renderWithProtocol(<AppShell><p /></AppShell>, { client });
    expect(await screen.findByRole("alert")).toHaveTextContent(/node unreachable/);
  });
});
