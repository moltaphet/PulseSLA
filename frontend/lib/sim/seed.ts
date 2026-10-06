/** A deterministic demo world: five insured endpoints with ~12 days of probe history, one paid claim, one claim in its grace period. */
import { DEFAULT_SIM_CONFIG, ProtocolError, SimProtocol } from "./engine";
import { SLA_TIERS } from "../pricing";
import { ATTO, DAY_SECONDS, daysToBlocks } from "../units";

export const DEMO_ACCOUNT = "0xde51000000000000000000000000000000000001";
const UW_ONE = "0x1111111111111111111111111111111111110001";
const UW_TWO = "0x2222222222222222222222222222222222220002";
const KEEPER = "0x3333333333333333333333333333333333330003";
const OPS = [
  "0xa000000000000000000000000000000000000001",
  "0xa000000000000000000000000000000000000002",
  "0xa000000000000000000000000000000000000003",
  "0xa000000000000000000000000000000000000004",
];

const gen = (n: number) => BigInt(n) * ATTO;
const GOLD = SLA_TIERS[0].uptimeBps;
const SILVER = SLA_TIERS[1].uptimeBps;

export const DEMO_ENDPOINTS = {
  helios: "rpc.helios-node.io",
  orbit: "api.orbit-indexer.xyz",
  nimbus: "relay.nimbus-bridge.net",
  vertex: "sequencer.vertex-l2.com",
  quartz: "rpc.quartz-labs.dev",
} as const;

const TICK = 6 * 3600;

export function createDemoWorld(now = Math.floor(Date.now() / 1000)): SimProtocol {
  const total = 3601 + 47 * TICK + 3700 + 1500;
  const sim = new SimProtocol(now - total, DEFAULT_SIM_CONFIG);
  for (const a of [DEMO_ACCOUNT, UW_ONE, UW_TWO, KEEPER, ...OPS]) sim.fund(a, gen(1000));

  sim.deposit(UW_ONE, gen(150));
  sim.deposit(UW_TWO, gen(100));
  sim.deposit(DEMO_ACCOUNT, gen(25));

  const make = (holder: string, host: string, cov: number, uptime: number, latency: number, days: number, mode: "rpc" | "http" = "rpc") => {
    const blocks = daysToBlocks(days);
    return sim.createPolicy(holder, {
      endpointUrl: `https://${host}`, maxLatencyMs: latency, coverage: gen(cov), durationBlocks: blocks,
      minUptimeBps: uptime, probeIntervalBlocks: 600, probeMode: mode,
    }, sim.quote(gen(cov), blocks, uptime));
  };
  make(DEMO_ACCOUNT, DEMO_ENDPOINTS.helios, 8, GOLD, 500, 60);
  make(OPS[0], DEMO_ENDPOINTS.orbit, 10, SILVER, 800, 30);
  make(OPS[1], DEMO_ENDPOINTS.nimbus, 15, GOLD, 600, 90);
  make(OPS[2], DEMO_ENDPOINTS.vertex, 12, GOLD, 400, 60);
  make(OPS[3], DEMO_ENDPOINTS.quartz, 6, SILVER, 1000, 45, "http");

  const round = () => {
    for (const p of sim.policies) {
      try {
        sim.triggerProbe(KEEPER, p.id, DEFAULT_SIM_CONFIG.probeBond);
      } catch (e) {
        if (!(e instanceof ProtocolError)) throw e;
      }
    }
  };

  sim.advance(3601); // clear every activation delay
  for (let tick = 0; tick < 47; tick++) {
    sim.advance(TICK);
    if (tick === 12) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "slow"); // a near-miss: two slow probes, then recovery
    if (tick === 14) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "healthy");
    if (tick === 24) sim.setEndpoint(DEMO_ENDPOINTS.vertex, "down"); // a full outage
    if (tick === 44) sim.setEndpoint(DEMO_ENDPOINTS.nimbus, "http504"); // an outage still inside its grace period
    round();
    if (tick === 26) {
      sim.advance(3700); // grace period elapses
      sim.settleClaim(KEEPER, 4, DEFAULT_SIM_CONFIG.probeBond);
      sim.setEndpoint(DEMO_ENDPOINTS.vertex, "healthy");
    }
  }
  sim.advance(1500);
  return sim;
}

export const DEMO_DAYS = 47 * TICK / DAY_SECONDS;
