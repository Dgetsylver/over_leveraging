/**
 * DeFindex Vault interaction helpers.
 *
 * Wraps the DeFindex vault contract (Soroban) for the leverage strategy.
 * Uses the same RPC and wallet signing patterns as blend.ts.
 */

import {
  Contract,
  TransactionBuilder,
  Account,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { server as blendServer, getNetworkPassphrase } from "./blend.ts";

// ── Vault configuration ──────────────────────────────────────────────────────

export interface VaultConfig {
  /** DeFindex vault contract address */
  vaultId: string;
  /** Underlying asset contract address (e.g. USDC) */
  assetId: string;
  /** Human-readable name */
  name: string;
  /** Asset symbol (e.g. "USDC") */
  assetSymbol: string;
  /** Asset decimals */
  decimals: number;
}

// Placeholder vault — to be updated with deployed vault address
export const VAULTS: VaultConfig[] = [
  {
    vaultId: "", // TODO: set after deployment
    assetId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
    name: "Leveraged USDC (Etherfuse)",
    assetSymbol: "USDC",
    decimals: 7,
  },
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultStats {
  totalEquity: number;     // Total vault equity in underlying terms
  totalShares: number;     // Total dfToken shares outstanding
  sharePrice: number;      // Price per share in underlying
  bTokens: bigint;         // Strategy b-tokens
  dTokens: bigint;         // Strategy d-tokens
  bRate: bigint;
  dRate: bigint;
  healthFactor: number;    // Strategy HF (1e7 scaled → float)
}

export interface UserVaultPosition {
  shares: number;          // User's dfToken balance
  underlyingValue: number; // Current value in underlying
  vault: VaultConfig;
}

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function invokeRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<xdr.ScVal> {
  const account = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Simulation failed`);
  }
  return sim.result!.retval;
}

// ── Vault queries ────────────────────────────────────────────────────────────

/**
 * Fetch vault stats from the strategy contract's `position()` method.
 */
export async function fetchVaultStats(vault: VaultConfig): Promise<VaultStats | null> {
  if (!vault.vaultId) return null;

  try {
    const result = await invokeRead(vault.vaultId, "position");

    // position() returns (equity, total_shares, b_tokens, d_tokens, b_rate, d_rate)
    const tuple = result.value() as xdr.ScVal[];
    const scalar = 10 ** vault.decimals;

    const totalEquity = Number(scValToNative(tuple[0])) / scalar;
    const totalShares = Number(scValToNative(tuple[1]));
    const bTokens = BigInt(scValToNative(tuple[2]).toString());
    const dTokens = BigInt(scValToNative(tuple[3]).toString());
    const bRate = BigInt(scValToNative(tuple[4]).toString());
    const dRate = BigInt(scValToNative(tuple[5]).toString());

    const sharePrice = totalShares > 0 ? totalEquity / (totalShares / scalar) : 1;

    // Fetch HF
    const hfResult = await invokeRead(vault.vaultId, "health_factor");
    const hfRaw = Number(scValToNative(hfResult));
    const healthFactor = hfRaw / 1e7;

    return {
      totalEquity,
      totalShares,
      sharePrice,
      bTokens,
      dTokens,
      bRate,
      dRate,
      healthFactor,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a user's vault balance via the strategy's `balance()` method.
 */
export async function fetchUserVaultBalance(
  vault: VaultConfig,
  userAddress: string
): Promise<UserVaultPosition | null> {
  if (!vault.vaultId) return null;

  try {
    const addressVal = nativeToScVal(userAddress, { type: "address" });
    const result = await invokeRead(vault.vaultId, "balance", [addressVal]);
    const underlying = Number(scValToNative(result));
    const scalar = 10 ** vault.decimals;

    return {
      shares: underlying / scalar, // balance() returns underlying value
      underlyingValue: underlying / scalar,
      vault,
    };
  } catch {
    return null;
  }
}

// ── Transaction builders ─────────────────────────────────────────────────────

/**
 * Build a deposit transaction XDR for the vault.
 */
export async function buildVaultDepositXdr(
  vault: VaultConfig,
  userAddress: string,
  amount: number
): Promise<string> {
  const scalar = 10 ** vault.decimals;
  const amountStroops = BigInt(Math.round(amount * scalar));

  const account = await blendServer.getAccount(userAddress);
  const contract = new Contract(vault.vaultId);

  const tx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM fee budget for complex tx
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      contract.call(
        "deposit",
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(userAddress, { type: "address" })
      )
    )
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Deposit simulation failed`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

/**
 * Build a withdraw transaction XDR for the vault.
 */
export async function buildVaultWithdrawXdr(
  vault: VaultConfig,
  userAddress: string,
  amount: number
): Promise<string> {
  const scalar = 10 ** vault.decimals;
  const amountStroops = BigInt(Math.round(amount * scalar));

  const account = await blendServer.getAccount(userAddress);
  const contract = new Contract(vault.vaultId);

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      contract.call(
        "withdraw",
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(userAddress, { type: "address" }),
        nativeToScVal(userAddress, { type: "address" }) // to = from
      )
    )
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Withdraw simulation failed`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatUsd(n: number, decimals = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatHf(hf: number): { text: string; cls: string } {
  if (!isFinite(hf) || hf > 100) return { text: "\u221e", cls: "hf-ok" };
  const text = hf.toFixed(4);
  if (hf >= 1.5) return { text, cls: "hf-ok" };
  if (hf >= 1.1) return { text, cls: "hf-warn" };
  return { text, cls: "hf-bad" };
}
