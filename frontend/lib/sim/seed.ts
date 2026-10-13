/** A deterministic demo world: five authenticated provider endpoints, ~12 days of corroborated probe history, one claim vesting out, one claim in its grace period. */
import { DEFAULT_SIM_CONFIG, ProtocolError, SimProtocol } from "./engine";
import { LISTING_DELAY_SECS, SLA_TIERS } from "../pricing";
import { ATTO, DAY_SECONDS, daysToBlocks } from "../units";

export const DEMO_ACCOUNT = "0xde51000000000000000000000000000000000001";
/** The registry governor of the demo world: lists endpoints, cannot hold policies. */
export const DEMO_GOVERNOR = "0x90e0000000000000000000000000000000000001";
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

/** The registry listings of the demo world: one per provider, all authenticated as chain 1. */
export const DEMO_REGISTRY = [
  { id: "helios-node", provider: "Helios Node", domain: "helios-node.io", host: DEMO_ENDPOINTS.helios },
  { id: "orbit-indexer", provider: "Orbit Indexer", domain: "orbit-indexer.xyz", host: DEMO_ENDPOINTS.orbit },
  { id: "nimbus-bridge", provider: "Nimbus Bridge", domain: "nimbus-bridge.net", host: DEMO_ENDPOINTS.nimbus },
  { id: "vertex-l2", provider: "Vertex L2", domain: "vertex-l2.com", host: DEMO_ENDPOINTS.vertex },
  { id: "quartz-labs", provider: "Quartz Labs", domain: "quartz-labs.dev", host: DEMO_ENDPOINTS.quartz },
] as const;

const TICK = 6 * 3600;
const TICKS = 47;

export function createDemoWorld(now = Math.floor(Date.now() / 1000)): SimProtocol {
  const total = LISTING_DELAY_SECS + 60 + 3601 + TICKS * TICK + 3700 + 1500;
  const sim = new SimProtocol(now - total, DEFAULT_SIM_CONFIG, 7, DEMO_GOVERNOR);
  for (const a of [DEMO_ACCOUNT, UW_ONE, UW_TWO, KEEPER, ...OPS]) sim.fund(a, gen(1000));

  // Authenticate and list the providers, then let the listing delay pass: only aged listings are insurable or count as references.
  for (const e of DEMO_REGISTRY) {
    sim.registerEndpoint(DEMO_GOVERNOR, { id: e.id, provider: e.provider, domain: e.domain, chainId: 1, url: `https://${e.host}` });
  }
  sim.advance(LISTING_DELAY_SECS + 60);

  sim.deposit(UW_ONE, gen(150));
  sim.deposit(UW_TWO, gen(100));
  sim.deposit(DEMO_ACCOUNT, gen(25));

  const make = (holder: string, endpointId: string, cov: number, uptime: number, days: number) => {
    const blocks = daysToBlocks(days);
    return sim.createPolicy(holder, {
      endpointId, coverage: gen(cov), durationBlocks: blocks, minUptimeBps: uptime, probeIntervalBlocks: 600,
    }, sim.quote(gen(cov), blocks, uptime));
  };
  make(DEMO_ACCOUNT, "helios-node", 8, GOLD, 60);
  make(OPS[0], "orbit-indexer", 10, SILVER, 30);
  make(OPS[1], "nimbus-bridge", 15, GOLD, 90);
  make(OPS[2], "vertex-l2", 12, GOLD, 60);
  make(OPS[3], "quartz-labs", 6, SILVER, 45);

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
  for (let tick = 0; tick < TICKS; tick++) {
    sim.advance(TICK);
    if (tick === 8) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "http502"); // a single failing round: not a breach
    if (tick === 9) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "healthy");
    if (tick === 12) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "ratelimited"); // throttling is inconclusive, never an outage
    if (tick === 15) sim.setEndpoint(DEMO_ENDPOINTS.orbit, "healthy");
    if (tick === 24) sim.setEndpoint(DEMO_ENDPOINTS.vertex, "down"); // a full, corroborated outage
    if (tick === 44) sim.setEndpoint(DEMO_ENDPOINTS.nimbus, "http504"); // an outage still inside its grace period
    round();
    if (tick === 26) {
      sim.advance(3700); // grace period elapses
      sim.settleClaim(KEEPER, 4, DEFAULT_SIM_CONFIG.probeBond); // breach confirmed: payout enters its cooldown
      sim.setEndpoint(DEMO_ENDPOINTS.vertex, "healthy");
    }
    if (tick === 34) sim.releasePayout(KEEPER, 4); // part of the stream has been released; the rest is still releasable
  }
  sim.advance(1500);
  return sim;
}

export const DEMO_DAYS = TICKS * TICK / DAY_SECONDS;
