import { LIMITS } from "./pricing";
import { formatGen, parseGen } from "./units";

/** Shares minted for a deposit (mirrors `deposit_underwriting`). Priced on GROSS assets; deposits are frozen while any claim is reserved. */
export function previewDeposit(amount: bigint, grossAssets: bigint, totalShares: bigint): bigint {
  if (totalShares === 0n || grossAssets === 0n) return amount;
  return (amount * totalShares) / grossAssets;
}

/** Shares burned for a withdrawal: rounded up so the pool is never under-charged. */
export function previewWithdrawBurn(amount: bigint, netAssets: bigint, totalShares: bigint): bigint {
  if (netAssets === 0n) return 0n;
  return (amount * totalShares + netAssets - 1n) / netAssets;
}

export interface AmountCheck {
  amount: bigint | null;
  error: string | null;
}

export function validateDeposit(input: string, balance: bigint | null): AmountCheck {
  if (input.trim() === "") return { amount: null, error: null };
  const amount = parseGen(input);
  if (amount === null) return { amount: null, error: "Enter a valid amount (up to 18 decimals)" };
  if (amount < LIMITS.minDeposit) return { amount: null, error: `Minimum deposit is ${formatGen(LIMITS.minDeposit, 3)} GEN` };
  if (balance !== null && amount > balance) return { amount: null, error: "Exceeds your wallet balance" };
  return { amount, error: null };
}

export function validateWithdraw(input: string, positionValue: bigint, withdrawable: bigint): AmountCheck {
  if (input.trim() === "") return { amount: null, error: null };
  const amount = parseGen(input);
  if (amount === null || amount === 0n) return { amount: null, error: "Enter a valid amount greater than zero" };
  if (amount > positionValue) return { amount: null, error: "Exceeds your position value" };
  if (amount > withdrawable) {
    return { amount: null, error: `Only ${formatGen(withdrawable)} GEN is withdrawable — the rest backs active coverage` };
  }
  return { amount, error: null };
}
