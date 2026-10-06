import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConsensusBreakdown } from "@/components/ConsensusBreakdown";
import { IncidentInspector } from "@/components/IncidentInspector";
import { LatencyChart } from "@/components/LatencyChart";
import { PolicyMarketplace } from "@/components/PolicyMarketplace";
import { Sentinel } from "@/components/Sentinel";
import { UnderwritingPortal } from "@/components/UnderwritingPortal";
import { UptimeBadge } from "@/components/UptimeBadge";
import { DemoClient } from "@/lib/chain/demo";
import { quotePremium } from "@/lib/pricing";
import { ATTO, daysToBlocks, formatGen } from "@/lib/units";
import { makeDemo, makeDemoUnfrozen, renderWithProtocol } from "./utils";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const demo = (c: unknown) => c as DemoClient;

describe("UnderwritingPortal", () => {
  it("shows pool metrics from the protocol", async () => {
    const { client } = renderWithProtocol(<UnderwritingPortal />);
    const tvl = await screen.findByTestId("stat-pool-tvl");
    expect(tvl).toHaveTextContent(`${formatGen(demo(client).sim.metrics().tvl, 2)} GEN`);
    expect(screen.getByTestId("stat-est-apy")).toHaveTextContent("%");
    expect(screen.getByTestId("stat-utilization")).toHaveTextContent("%");
    expect(screen.getByText("Solvent")).toBeInTheDocument();
    expect(screen.getByText(/No capital deposited|Value/)).toBeInTheDocument();
  });

  it("validates deposit amounts before enabling the button", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<UnderwritingPortal />, { client: makeDemoUnfrozen() });
    const input = await screen.findByLabelText(/amount to deposit/i);
    const submit = screen.getByRole("button", { name: /deposit to pool/i });
    expect(submit).toBeDisabled();
    await user.type(input, "abc");
    expect(screen.getByRole("alert")).toHaveTextContent(/valid amount/i);
    await user.clear(input);
    await user.type(input, "0.0001");
    expect(screen.getByRole("alert")).toHaveTextContent(/Minimum deposit/);
    await user.clear(input);
    await user.type(input, "99999999");
    expect(screen.getByRole("alert")).toHaveTextContent(/wallet balance/i);
    expect(submit).toBeDisabled();
  });

  it("previews shares and deposits into the pool", async () => {
    const user = userEvent.setup();
    const { client } = renderWithProtocol(<UnderwritingPortal />, { client: makeDemoUnfrozen() });
    const before = demo(client).sim.metrics().tvl;
    await user.type(await screen.findByLabelText(/amount to deposit/i), "10");
    expect(screen.getByText("Shares minted")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /deposit to pool/i }));
    await waitFor(() => expect(demo(client).sim.metrics().tvl).toBe(before + 10n * ATTO));
    await waitFor(() => expect(screen.getByLabelText(/amount to deposit/i)).toHaveValue(""));
  });

  it("freezes deposits (but not withdrawals) while a claim is pending", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<UnderwritingPortal />); // the seeded world has a staged claim on relay.nimbus-bridge.net
    const submit = await screen.findByRole("button", { name: /deposits frozen/i });
    expect(submit).toBeDisabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(/Deposits are frozen while a staged claim is reserved/);
    await user.click(screen.getByRole("tab", { name: "Withdraw" }));
    expect(screen.queryByText(/Deposits are frozen/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /withdraw from pool/i })).toBeInTheDocument();
  });

  it("limits withdrawals to the unlocked portion of the position", async () => {
    const user = userEvent.setup();
    const { client } = renderWithProtocol(<UnderwritingPortal />);
    await user.click(await screen.findByRole("tab", { name: "Withdraw" }));
    const input = screen.getByLabelText(/amount to withdraw/i);
    await user.type(input, "10000");
    expect(screen.getByRole("alert")).toHaveTextContent(/position value/);
    await user.clear(input);
    await user.type(input, "5");
    await user.click(screen.getByRole("button", { name: /withdraw from pool/i }));
    await waitFor(() => expect(demo(client).sim.transfers.at(-1)?.amount).toBe(5n * ATTO));
  });

  it("Max fills the withdrawable amount", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<UnderwritingPortal />);
    await user.click(await screen.findByRole("tab", { name: "Withdraw" }));
    await user.click(screen.getByRole("button", { name: "Max" }));
    expect(screen.getByLabelText(/amount to withdraw/i)).not.toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("PolicyMarketplace", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, url: string, coverage: string) => {
    await user.type(await screen.findByLabelText("Endpoint URL"), url);
    await user.type(screen.getByLabelText("Coverage amount"), coverage);
  };

  it("rejects unsafe endpoints as you type", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await user.type(await screen.findByLabelText("Endpoint URL"), "http://127.0.0.1:8545");
    expect(screen.getByRole("alert")).toHaveTextContent(/Private and reserved/);
    expect(screen.getByRole("button", { name: /mint policy/i })).toBeDisabled();
  });

  it("previews the exact premium the contract will charge", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await fill(user, "https://rpc.fresh-node.io", "5");
    const gold = quotePremium(5n * ATTO, daysToBlocks(30), 9990);
    expect(screen.getByTestId("premium")).toHaveTextContent(`${formatGen(gold, 6)} GEN`);
    await user.click(screen.getByRole("radio", { name: /Silver/ }));
    const silver = quotePremium(5n * ATTO, daysToBlocks(30), 9900);
    expect(silver).toBeLessThan(gold);
    expect(screen.getByTestId("premium")).toHaveTextContent(`${formatGen(silver, 6)} GEN`);
    await user.click(screen.getByRole("button", { name: "90d" }));
    expect(screen.getByTestId("premium")).toHaveTextContent(`${formatGen(quotePremium(5n * ATTO, daysToBlocks(90), 9900), 6)} GEN`);
  });

  it("explains the exposure cap that blocks oversized coverage", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await fill(user, "https://rpc.fresh-node.io", "500");
    expect(screen.getByRole("alert")).toHaveTextContent(/at most .* GEN.*cap/);
    expect(screen.getByRole("button", { name: /mint policy/i })).toBeDisabled();
  });

  it("flags out-of-range parameters", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await fill(user, "https://rpc.fresh-node.io", "1");
    const latency = screen.getByLabelText("Max latency");
    await user.clear(latency);
    await user.type(latency, "5");
    expect(screen.getByText(/Enter 50–30,000 ms/)).toBeInTheDocument();
    await user.clear(latency);
    await user.type(latency, "400");
    const days = screen.getByLabelText("Duration");
    await user.clear(days);
    await user.type(days, "999");
    expect(screen.getByText(/between 1 hour and 365 days/)).toBeInTheDocument();
  });

  it("mints a policy and links to the sentinel", async () => {
    const user = userEvent.setup();
    const { client } = renderWithProtocol(<PolicyMarketplace />);
    await fill(user, "https://rpc.fresh-node.io", "5");
    await user.click(screen.getByRole("button", { name: /mint policy · pay/i }));
    const banner = await screen.findByText(/Policy #6 minted/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sentinel/ })).toHaveAttribute("href", "/sentinel?policy=6");
    const p = demo(client).sim.get(6);
    expect(p).toMatchObject({ host: "rpc.fresh-node.io", coverage: 5n * ATTO, minUptimeBps: 9990 });
    expect(screen.getByLabelText("Endpoint URL")).toHaveValue("");
  });
});

describe("Sentinel", () => {
  it("lists every insured endpoint, breaches first", async () => {
    renderWithProtocol(<Sentinel />);
    const list = await screen.findByRole("complementary", { name: /insured endpoints/i });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("relay.nimbus-bridge.net");
    expect(items[0]).toHaveTextContent("Breach confirmed");
    expect(within(list).getAllByText("Healthy").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the breach, the uptime badge, the chart and the consensus roll", async () => {
    renderWithProtocol(<Sentinel />);
    const detail = await screen.findByTestId("sentinel-detail");
    expect(within(detail).getByRole("alert")).toHaveTextContent(/SLA breach confirmed/);
    expect(within(detail).getByTestId("uptime-value")).toHaveTextContent("%");
    expect(within(detail).getAllByTestId("probe-point").length).toBeGreaterThan(10);
    expect(within(detail).getByTestId("consensus-breakdown")).toHaveTextContent(/of 5 validators agree/);
    expect(within(detail).getByRole("button", { name: "Settle claim" })).toBeDisabled();
    expect(within(detail).getByText(/Grace period ends in/)).toBeInTheDocument();
  });

  it("settles a staged claim once the grace period has elapsed", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    client.advance(3 * 3600);
    renderWithProtocol(<Sentinel />, { client });
    const settle = await screen.findByRole("button", { name: "Settle claim" });
    await waitFor(() => expect(settle).toBeEnabled());
    await user.click(settle);
    await waitFor(() => expect(client.sim.get(3).status).toBe("PAID"));
    expect(await screen.findByText(/Claim paid\./)).toBeInTheDocument();
    expect(client.sim.metrics().solvent).toBe(true);
  });

  it("explains why a probe is not yet allowed, and runs one when it is", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    renderWithProtocol(<Sentinel />, { client });
    await user.click(await screen.findByRole("button", { name: /rpc\.helios-node\.io/ }));
    const detail = screen.getByTestId("sentinel-detail");
    expect(within(detail).getByRole("button", { name: "Trigger probe" })).toBeDisabled();
    expect(within(detail).getByText(/Next probe allowed in/)).toBeInTheDocument();
  });

  it("probes when eligible and records the validator roll", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    client.advance(3 * 3600);
    renderWithProtocol(<Sentinel />, { client });
    await user.click(await screen.findByRole("button", { name: /rpc\.helios-node\.io/ }));
    const before = client.sim.incidents.length;
    const probe = screen.getByRole("button", { name: "Trigger probe" });
    await waitFor(() => expect(probe).toBeEnabled());
    await user.click(probe);
    await waitFor(() => expect(client.sim.incidents.length).toBe(before + 1));
    expect(await screen.findByTestId("consensus-breakdown")).toHaveTextContent(/validator-1/);
  });

  it("filters to my policies", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<Sentinel />);
    await user.click(await screen.findByLabelText(/only my policies/i));
    const list = screen.getByRole("complementary", { name: /insured endpoints/i });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(list).toHaveTextContent("rpc.helios-node.io");
  });

  it("honours a deep-linked policy id", async () => {
    renderWithProtocol(<Sentinel initialPolicyId={4} />);
    expect(await screen.findByRole("heading", { name: "sequencer.vertex-l2.com" })).toBeInTheDocument();
    expect(screen.getByText(/Claim paid\./)).toBeInTheDocument();
  });
});

describe("IncidentInspector", () => {
  it("summarises breaches and lists parametric payouts", async () => {
    renderWithProtocol(<IncidentInspector />);
    expect(await screen.findByTestId("stat-breaches-confirmed")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-claims-paid")).toHaveTextContent("1");
    const payouts = screen.getByRole("heading", { name: "Parametric payouts" }).closest("section")!;
    expect(payouts).toHaveTextContent("sequencer.vertex-l2.com");
    expect(payouts).toHaveTextContent(/−[\d.]+ GEN/);
  });

  it("defaults to breach events and drills into the consensus reasoning", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<IncidentInspector />);
    const log = await screen.findByRole("list", { name: "Incident events" });
    const rows = within(log).getAllByRole("button");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const payoutRow = rows.find((r) => /re-verification confirmed breach/.test(r.textContent ?? ""))!;
    expect(payoutRow).toHaveAttribute("aria-expanded", "false");
    await user.click(payoutRow);
    const detail = await screen.findByTestId("incident-detail");
    expect(within(detail).getByText("HTTP status")).toBeInTheDocument();
    expect(within(detail).getByText("Consensus verdict")).toBeInTheDocument();
    expect(within(detail).getByTestId("consensus-breakdown")).toBeInTheDocument();
    await user.click(payoutRow);
    expect(screen.queryByTestId("incident-detail")).not.toBeInTheDocument();
  });

  it("filters to failing probes and by policy", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<IncidentInspector />);
    await user.click(await screen.findByRole("button", { name: "Failing probes" }));
    const log = screen.getByRole("list", { name: "Incident events" });
    const rows = within(log).getAllByRole("button");
    expect(rows.every((r) => /Probe · failing/.test(r.textContent ?? ""))).toBe(true);
    await user.selectOptions(screen.getByLabelText("Filter by policy"), "4");
    const filtered = within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(rows.length);
    await user.click(screen.getByRole("button", { name: "Payouts" }));
    expect(within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button")).toHaveLength(1);
  });

  it("shows an empty state when nothing matches", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<IncidentInspector />);
    await user.click(await screen.findByRole("button", { name: "Payouts" }));
    await user.selectOptions(screen.getByLabelText("Filter by policy"), "1");
    expect(screen.getByText("No events match this filter")).toBeInTheDocument();
  });
});

describe("presentational pieces", () => {
  const pt = (i: number, ok: boolean, ms: number) => ({ index: i, time: 1000 + i * 60, latencyMs: ms, ok, reason: ok ? "OK" : "HTTP_ERROR", status: ok ? 200 : 502, block: 10 });

  it("LatencyChart draws every probe, the SLA line, and colours failures", () => {
    render(<LatencyChart points={[pt(1, true, 80), pt(2, false, 9000), pt(3, true, 120)]} limitMs={500} />);
    const points = screen.getAllByTestId("probe-point");
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.getAttribute("data-ok"))).toEqual(["true", "false", "true"]);
    expect(points[1]).toHaveAttribute("data-clipped");
    expect(screen.getByTestId("sla-line")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName(/3 probes against the 500 millisecond limit; 1 failed/);
  });

  it("LatencyChart has an empty state and caps the window", () => {
    const { rerender } = render(<LatencyChart points={[]} limitMs={500} />);
    expect(screen.getByText("No probes recorded yet")).toBeInTheDocument();
    rerender(<LatencyChart points={Array.from({ length: 200 }, (_, i) => pt(i, true, 50))} limitMs={500} max={50} />);
    expect(screen.getAllByTestId("probe-point")).toHaveLength(50);
  });

  it("UptimeBadge compares measured uptime with the SLA", () => {
    const { rerender } = render(<UptimeBadge uptimeBps={9995} slaBps={9990} samples={40} />);
    expect(screen.getByTestId("uptime-value")).toHaveTextContent("99.95%");
    expect(screen.getByRole("group")).toHaveAccessibleName("Uptime 99.95% against SLA 99.90%");
    expect(screen.getByRole("group").className).toMatch(/text-pulse/);
    rerender(<UptimeBadge uptimeBps={9300} slaBps={9990} samples={43} />);
    expect(screen.getByRole("group").className).toMatch(/text-danger/);
    rerender(<UptimeBadge uptimeBps={10000} slaBps={9990} samples={0} />);
    expect(screen.getByTestId("uptime-value")).toHaveTextContent("—");
  });

  it("ConsensusBreakdown tallies agreement and flags a failed quorum", () => {
    const vote = (n: number, agree: boolean) => ({ validator: `validator-${n}`, role: n === 1 ? ("leader" as const) : ("validator" as const), agree, reason: "OK" as const, status: 200, latencyMs: 90, block: 5 });
    const { rerender } = render(<ConsensusBreakdown votes={[vote(1, true), vote(2, true), vote(3, true), vote(4, false), vote(5, true)]} />);
    expect(screen.getByText("4 of 5 validators agree")).toBeInTheDocument();
    expect(screen.getByText("Consensus reached")).toBeInTheDocument();
    expect(screen.getByText("leader")).toBeInTheDocument();
    rerender(<ConsensusBreakdown votes={[vote(1, true), vote(2, false), vote(3, false)]} />);
    expect(screen.getByText("No consensus")).toBeInTheDocument();
    rerender(<ConsensusBreakdown votes={[{ validator: "0xabc", role: "leader", agree: true }]} />);
    expect(screen.getByText("agrees", { selector: "span.num" })).toBeInTheDocument();
    rerender(<ConsensusBreakdown />);
    expect(screen.getByText(/No vote roll recorded/)).toBeInTheDocument();
  });
});
