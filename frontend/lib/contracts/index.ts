/**
 * The deployed PulseSLA contract. `deployment.json` and `abi.json` are written by
 * `python -m scripts.deploy`; NEXT_PUBLIC_PULSESLA_ADDRESS overrides the address
 * per environment.
 */
import abiJson from "./abi.json";
import deploymentJson from "./deployment.json";

export interface AbiMethod {
  name: string;
  inputs: { name: string; type: string }[];
  readonly: boolean;
  payable: boolean;
  returns: string | null;
}

export const PULSESLA_ABI = abiJson as AbiMethod[];

interface Deployment {
  contract_address?: string | null;
  deploy_tx?: string;
  deployer?: string;
  constructor_args?: { activation_delay_secs: number; claim_grace_secs: number; probe_bond: string };
}
export const DEPLOYMENT = deploymentJson as Deployment;

export const CONTRACT_ADDRESS: string | null =
  process.env.NEXT_PUBLIC_PULSESLA_ADDRESS ?? DEPLOYMENT.contract_address ?? null;
