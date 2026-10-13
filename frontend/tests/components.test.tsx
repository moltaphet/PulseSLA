import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConsensusBreakdown } from "@/components/ConsensusBreakdown";
import { IncidentInspector } from "@/components/IncidentInspector";
import { BlockLagChart } from "@/components/BlockLagChart";
import { PolicyMarketplace } from "@/components/PolicyMarketplace";
import { Sentinel } from "@/components/Sentinel";
import { UnderwritingPortal } from "@/components/UnderwritingPortal";
import { UptimeBadge } from "@/components/UptimeBadge";
import { DemoClient } from "@/lib/chain/demo";
import { quotePremium } from "@/lib/pricing";
import { ATTO, daysToBlocks, formatGen } from "@/lib/units";
import { DEMO_GOVERNOR } from "@/lib/sim/seed";
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
  const fill = async (user: ReturnType<typeof userEvent.setup>, provider: RegExp, coverage: string) => {
    await user.click(await screen.findByRole("radio", { name: provider }));
    await user.type(screen.getByLabelText("Coverage amount"), coverage);
  };

  it("offers only authenticated registry endpoints: there is no URL input", async () => {
    renderWithProtocol(<PolicyMarketplace />);
    const group = await screen.findByRole("radiogroup", { name: "Authenticated endpoint" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    expect(within(group).getByRole("radio", { name: /Helios Node/ })).toBeEnabled();
    expect(screen.queryByLabelText(/Endpoint URL/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Max latency/i)).not.toBeInTheDocument();
    expect(screen.getByText(/never takes a URL/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mint policy/i })).toBeDisabled();
  });

  it("will not let you pick a delisted or still-authenticating listing", async () => {
    const client = makeDemo();
    client.sim.delistEndpoint(DEMO_GOVERNOR, "quartz-labs");
    renderWithProtocol(<PolicyMarketplace />, { client });
    const quartz = await screen.findByRole("radio", { name: /Quartz Labs/ });
    expect(quartz).toBeDisabled();
    expect(within(quartz.closest("label")!).getByText("Delisted")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Helios Node/ })).toBeEnabled();
  });

  it("previews the exact premium the contract will charge", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await fill(user, /Quartz Labs/, "5");
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
    await fill(user, /Quartz Labs/, "500");
    expect(screen.getByRole("alert")).toHaveTextContent(/at most .* GEN.*cap/);
    expect(screen.getByRole("button", { name: /mint policy/i })).toBeDisabled();
  });

  it("flags out-of-range parameters", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<PolicyMarketplace />);
    await fill(user, /Quartz Labs/, "1");
    const days = screen.getByLabelText("Duration");
    await user.clear(days);
    await user.type(days, "999");
    expect(screen.getByText(/between 1 hour and 365 days/)).toBeInTheDocument();
  });

  it("mints a policy on a registry id and links to the sentinel", async () => {
    const user = userEvent.setup();
    const { client } = renderWithProtocol(<PolicyMarketplace />);
    await fill(user, /Quartz Labs/, "5");
    await user.click(screen.getByRole("button", { name: /mint policy · pay/i }));
    const banner = await screen.findByText(/Policy #6 minted/);
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sentinel/ })).toHaveAttribute("href", "/sentinel?policy=6");
    const p = demo(client).sim.get(6);
    expect(p).toMatchObject({ endpointId: "quartz-labs", host: "rpc.quartz-labs.dev", coverage: 5n * ATTO, minUptimeBps: 9990 });
    expect(screen.getByRole("radio", { name: /Quartz Labs/ })).not.toBeChecked();
  });
});

describe("Sentinel", () => {
  it("lists every insured endpoint, breaches first", async () => {
    renderWithProtocol(<Sentinel />);
    const list = await screen.findByRole("complementary", { name: /insured endpoints/i });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent("relay.nimbus-bridge.net");
    expect(items[0]).toHaveTextContent("Breach staged");
    expect(items[1]).toHaveTextContent("sequencer.vertex-l2.com");
    expect(items[1]).toHaveTextContent("Payout vesting");
    expect(within(list).getAllByText("Healthy").length).toBeGreaterThanOrEqual(2);
  });

  it("shows the staged outage, the uptime badge, the chart and the consensus roll", async () => {
    renderWithProtocol(<Sentinel />);
    const detail = await screen.findByTestId("sentinel-detail");
    expect(within(detail).getByRole("alert")).toHaveTextContent(/Corroborated outage staged/);
    expect(within(detail).getByText("Outage continuity")).toBeInTheDocument();
    expect(within(detail).getByTestId("uptime-value")).toHaveTextContent("%");
    expect(within(detail).getAllByTestId("probe-point").length).toBeGreaterThan(10);
    expect(within(detail).getByTestId("consensus-breakdown")).toHaveTextContent(/of 5 validators agree/);
    expect(within(detail).getByRole("button", { name: "Settle claim" })).toBeDisabled();
    expect(within(detail).getByText(/Grace period ends in/)).toBeInTheDocument();
  });

  it("confirms a staged claim after the grace period; the payout then vests rather than paying at once", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    client.advance(3 * 3600);
    const holderBefore = client.sim.balanceOf(client.sim.get(3).holder);
    renderWithProtocol(<Sentinel />, { client });
    const settle = await screen.findByRole("button", { name: "Settle claim" });
    await waitFor(() => expect(settle).toBeEnabled());
    await user.click(settle);
    await waitFor(() => expect(client.sim.get(3).status).toBe("VESTING"));
    expect(await screen.findByText(/Breach confirmed — payout vesting\./)).toBeInTheDocument();
    expect(client.sim.balanceOf(client.sim.get(3).holder)).toBe(holderBefore); // nothing moved yet
    expect(screen.getByRole("button", { name: "Release payout" })).toBeDisabled();
    expect(screen.getByText(/Cooldown ends in/)).toBeInTheDocument();
    expect(client.sim.metrics().solvent).toBe(true);
  });

  it("releases the vested payout to the holder once the cooldown has passed", async () => {
    const user = userEvent.setup();
    const client = makeDemo();
    renderWithProtocol(<Sentinel initialPolicyId={4} />, { client });
    const release = await screen.findByRole("button", { name: "Release payout" });
    await waitFor(() => expect(release).toBeEnabled());
    const holder = client.sim.get(4).holder;
    const before = client.sim.balanceOf(holder);
    const owed = client.sim.get(4).releasable;
    expect(owed).toBeGreaterThan(0n);
    await user.click(release);
    await waitFor(() => expect(client.sim.balanceOf(holder)).toBe(before + owed));
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
    expect(screen.getByText(/Breach confirmed — payout vesting\./)).toBeInTheDocument();
  });
});

describe("IncidentInspector", () => {
  it("summarises breaches and lists parametric payouts with their vesting progress", async () => {
    renderWithProtocol(<IncidentInspector />);
    expect(await screen.findByTestId("stat-breaches-confirmed")).toHaveTextContent("1");
    expect(screen.getByTestId("stat-inconclusive-rounds")).toHaveTextContent("3");
    expect(Number(screen.getByTestId("stat-failing-rounds").textContent?.match(/\d+/)?.[0])).toBeGreaterThan(0);
    const payouts = screen.getByRole("heading", { name: "Parametric payouts" }).closest("section")!;
    expect(payouts).toHaveTextContent("sequencer.vertex-l2.com");
    expect(payouts).toHaveTextContent(/−[\d.]+ GEN/);
    expect(payouts).toHaveTextContent(/released · .* releasable now/);
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
    expect(within(detail).getByText("Reference baseline")).toBeInTheDocument();
    expect(within(detail).getByText("HTTP status")).toBeInTheDocument();
    expect(within(detail).getByText("Corroborated verdict")).toBeInTheDocument();
    expect(within(detail).getByTestId("consensus-breakdown")).toBeInTheDocument();
    await user.click(payoutRow);
    expect(screen.queryByTestId("incident-detail")).not.toBeInTheDocument();
  });

  it("filters to failing rounds and by policy", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<IncidentInspector />);
    await user.click(await screen.findByRole("button", { name: "Failing rounds" }));
    const log = screen.getByRole("list", { name: "Incident events" });
    const rows = within(log).getAllByRole("button");
    expect(rows.every((r) => /Probe · failing/.test(r.textContent ?? ""))).toBe(true);
    await user.selectOptions(screen.getByLabelText("Filter by policy"), "4");
    const filtered = within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(rows.length);
    await user.click(screen.getByRole("button", { name: "Payouts" }));
    // the confirmation and each release for the vertex policy
    const payoutRows = within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button");
    expect(payoutRows.length).toBeGreaterThanOrEqual(2);
    expect(payoutRows.some((r) => /Payout released/.test(r.textContent ?? ""))).toBe(true);
  });

  it("separates inconclusive rounds from failures and lists registry events", async () => {
    const user = userEvent.setup();
    renderWithProtocol(<IncidentInspector />);
    await user.click(await screen.findByRole("button", { name: "Inconclusive rounds" }));
    const rows = within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => /Probe · inconclusive/.test(r.textContent ?? ""))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Registry" }));
    const reg = within(screen.getByRole("list", { name: "Incident events" })).getAllByRole("button");
    expect(reg).toHaveLength(5);
    expect(reg[0]).toHaveTextContent("Endpoint listed");
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
  const pt = (i: number, verdict: "HEALTHY" | "FAILING" | "INCONCLUSIVE", lag: number | null) => ({
    index: i, time: 1000 + i * 60, verdict, ok: verdict === "HEALTHY", reason: verdict === "HEALTHY" ? "OK" : "HTTP_ERROR",
    status: verdict === "HEALTHY" ? 200 : 502, block: lag === null ? -1 : 1000 - lag, refHead: 1000, lagBlocks: lag,
  });

  it("BlockLagChart draws every round against the staleness line, colouring failures and hollowing inconclusive rounds", () => {
    render(<BlockLagChart points={[pt(1, "HEALTHY", 2), pt(2, "FAILING", null), pt(3, "INCONCLUSIVE", null), pt(4, "FAILING", 90)]} limit={50} />);
    const points = screen.getAllByTestId("probe-point");
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.getAttribute("data-verdict"))).toEqual(["HEALTHY", "FAILING", "INCONCLUSIVE", "FAILING"]);
    expect(points[1]).toHaveAttribute("data-unobserved");
    expect(points[2].getAttribute("fill")).toBe("none");
    expect(screen.getByTestId("sla-line")).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAccessibleName(/4 rounds against the 50 block limit; 2 failing, 1 inconclusive/);
  });

  it("BlockLagChart has an empty state and caps the window", () => {
    const { rerender } = render(<BlockLagChart points={[]} limit={50} />);
    expect(screen.getByText("No corroborated rounds recorded yet")).toBeInTheDocument();
    rerender(<BlockLagChart points={Array.from({ length: 200 }, (_, i) => pt(i, "HEALTHY", 1))} limit={50} max={50} />);
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
    const vote = (n: number, agree: boolean) => ({ validator: `validator-${n}`, role: n === 1 ? ("leader" as const) : ("validator" as const), agree, verdict: "HEALTHY" as const, reason: "OK" as const, status: 200, block: 5, refsOk: 4 });
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
