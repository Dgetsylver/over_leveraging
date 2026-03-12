/**
 * Blend pool interactions — CETES leverage on Etherfuse pool.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

export const POOL_ID  = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
export const CETES_ID = "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV";
export const BLND_ID  = "CD25MNVTZDL4Y3XBCPCJXGC7P7Q4BH5B7CTZSN7YXCEUN56HAQBCM7E";
export const NETWORK  = Networks.PUBLIC;
export const RPC_URL  = "https://mainnet.sorobanrpc.com";

// CETES reserve index = 2 in this pool.
// Supply emissions token id = index * 2 + 1 = 5
// Borrow emissions token id = index * 2     = 4
export const CETES_RESERVE_INDEX     = 2;
export const CETES_SUPPLY_TOKEN_ID   = CETES_RESERVE_INDEX * 2 + 1; // 5
export const CETES_BORROW_TOKEN_ID   = CETES_RESERVE_INDEX * 2;     // 4

const SCALAR    = 10_000_000n;
const SCALAR_F  = 10_000_000;
const RATE_DEC  = 1_000_000_000_000; // 12 decimals for b_rate / d_rate

export const SUPPLY_COLLATERAL = 2;
export const WITHDRAW_COLLATERAL = 3;
export const REPAY  = 5;
export const BORROW = 4;

// ── RPC server ────────────────────────────────────────────────────────────────

export const server = new SorobanRpc.Server(RPC_URL);

// ── ScVal helpers ─────────────────────────────────────────────────────────────

export function i128ToScVal(n: bigint): xdr.ScVal {
  const hi = n < 0n ? ~((-n - 1n) >> 64n) & 0xFFFFFFFFFFFFFFFFn : n >> 64n;
  const lo = n & 0xFFFFFFFFFFFFFFFFn;
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    })
  );
}

function buildRequest(assetId: string, amount: bigint, requestType: number): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: new Address(assetId).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"),  val: i128ToScVal(amount) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: nativeToScVal(requestType, { type: "u32" }) }),
  ]);
}

function buildRequestsVec(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

// ── Leverage math ─────────────────────────────────────────────────────────────

export function leverageAt(loops: number, c: number): number {
  return (1 - Math.pow(c, loops + 1)) / (1 - c);
}

export function hfAt(loops: number, c: number): number {
  // HF = (1 - c^(n+1)) / (1 - c^n)
  return (1 - Math.pow(c, loops + 1)) / (1 - Math.pow(c, loops));
}

/** Build n borrows + (n+1) supplies request list for opening a position. */
function buildOpenRequests(initialStroops: bigint, cFactor: bigint, n: number): xdr.ScVal[] {
  const items: xdr.ScVal[] = [];
  let balance = initialStroops;
  for (let i = 0; i < n; i++) {
    const supply = balance;
    const borrow = supply * cFactor / SCALAR;
    items.push(buildRequest(CETES_ID, supply, SUPPLY_COLLATERAL));
    items.push(buildRequest(CETES_ID, borrow, BORROW));
    balance = borrow;
  }
  items.push(buildRequest(CETES_ID, balance, SUPPLY_COLLATERAL));
  return items;
}

/** Build close-all requests: one WITHDRAW_COLLATERAL (max) + one REPAY (max).
 *  Blend caps both at the actual balance so large values are safe. */
function buildCloseRequests(collateralStroops: bigint, debtStroops: bigint): xdr.ScVal[] {
  // Add 0.1% buffer to debt to cover interest that accrues between read and submit
  const debtWithBuffer = debtStroops * 1001n / 1000n;
  return [
    buildRequest(CETES_ID, collateralStroops, WITHDRAW_COLLATERAL),
    buildRequest(CETES_ID, debtWithBuffer, REPAY),
  ];
}

// ── Pool data ─────────────────────────────────────────────────────────────────

export interface PoolStats {
  cFactor:      bigint;
  cFactorPct:   number;
  availableUsdc: number; // CETES available to borrow
  supplyApr:    number;
  borrowApr:    number;
}

export async function fetchPoolStats(address: string): Promise<PoolStats> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(address);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(pool.call("get_reserve", new Address(CETES_ID).toScVal()))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) throw new Error("get_reserve simulation failed");
  const raw: any = scValToNative(sim.result!.retval);
  const cFactor = BigInt(raw.config.c_factor);
  const bRate = BigInt(raw.data.b_rate);
  const dRate = BigInt(raw.data.d_rate);
  const bSupply = BigInt(raw.data.b_supply);
  const dSupply = BigInt(raw.data.d_supply);
  const maxUtil = raw.config.max_util as number;

  const totalSupplied = Number(bSupply * bRate / BigInt(RATE_DEC)) / SCALAR_F;
  const totalBorrowed = Number(dSupply * dRate / BigInt(RATE_DEC)) / SCALAR_F;
  const available = totalSupplied * (maxUtil / SCALAR_F) - totalBorrowed;

  // Simple APR from interest rate model (annualised rate approximation)
  const util = raw.config.util / SCALAR_F;
  const rBase = raw.config.r_base / SCALAR_F;
  const rOne  = raw.config.r_one  / SCALAR_F;
  const borrowApr = (rBase + rOne * Math.min(util, 1)) * 100;
  const supplyApr = borrowApr * util * (1 - 0.1); // rough supply APR after backstop take

  return {
    cFactor,
    cFactorPct: Number(cFactor) / SCALAR_F * 100,
    availableUsdc: Math.max(0, available),
    supplyApr,
    borrowApr,
  };
}

export interface Position {
  collateralBtokens: bigint;
  debtDtokens:       bigint;
  collateralCetes:   number; // real CETES
  debtCetes:         number;
  equity:            number;
  leverage:          number;
  hf:                number;
}

export async function fetchPosition(userAddress: string): Promise<Position | null> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(userAddress);

  // get_positions
  const posTx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(pool.call("get_positions", new Address(userAddress).toScVal()))
    .setTimeout(30).build();
  const posSim = await server.simulateTransaction(posTx);
  if (!SorobanRpc.Api.isSimulationSuccess(posSim)) return null;
  const posRaw: any = scValToNative(posSim.result!.retval);

  const bTokens = BigInt(posRaw.collateral?.[CETES_RESERVE_INDEX] ?? 0);
  const dTokens = BigInt(posRaw.liabilities?.[CETES_RESERVE_INDEX] ?? 0);
  if (bTokens === 0n && dTokens === 0n) return null;

  // get current rates
  const resTx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(pool.call("get_reserve", new Address(CETES_ID).toScVal()))
    .setTimeout(30).build();
  const resSim = await server.simulateTransaction(resTx);
  if (!SorobanRpc.Api.isSimulationSuccess(resSim)) return null;
  const resRaw: any = scValToNative(resSim.result!.retval);

  const bRate = BigInt(resRaw.data.b_rate);
  const dRate = BigInt(resRaw.data.d_rate);
  const cFactor = Number(resRaw.config.c_factor) / SCALAR_F;

  const collateralStroops = bTokens * bRate / BigInt(RATE_DEC);
  const debtStroops       = dTokens * dRate / BigInt(RATE_DEC);
  const collateralCetes   = Number(collateralStroops) / SCALAR_F;
  const debtCetes         = Number(debtStroops) / SCALAR_F;
  const equity            = collateralCetes - debtCetes;
  const leverage          = equity > 0 ? collateralCetes / equity : 0;
  const hf                = debtCetes > 0 ? (collateralCetes * cFactor) / debtCetes : 999;

  return { collateralBtokens: bTokens, debtDtokens: dTokens, collateralCetes, debtCetes, equity, leverage, hf };
}

export async function fetchCetesBalance(userAddress: string): Promise<number> {
  const cetes = new Contract(CETES_ID);
  const acc   = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(cetes.call("balance", new Address(userAddress).toScVal()))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return 0;
  const raw = scValToNative(sim.result!.retval);
  const stroops = typeof raw === "bigint" ? raw : BigInt(raw as any);
  return Number(stroops) / SCALAR_F;
}

export async function fetchPendingBlnd(userAddress: string): Promise<number> {
  const pool = new Contract(POOL_ID);
  const acc  = await server.getAccount(userAddress);

  let total = 0;
  for (const tokenId of [CETES_SUPPLY_TOKEN_ID, CETES_BORROW_TOKEN_ID]) {
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(pool.call(
        "get_user_emissions",
        new Address(userAddress).toScVal(),
        nativeToScVal(tokenId, { type: "u32" }),
      ))
      .setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) continue;
    const raw: any = scValToNative(sim.result!.retval);
    // accrued field is in BLND stroops (1e7)
    if (raw?.accrued) total += Number(BigInt(raw.accrued)) / SCALAR_F;
  }
  return total;
}

// ── Transaction builders (unsigned XDR) ──────────────────────────────────────

export async function buildApproveXdr(userAddress: string, amountStroops: bigint): Promise<string> {
  const cetes     = new Contract(CETES_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const poolScVal = new Address(POOL_ID).toScVal();
  const ledger    = await server.getLatestLedger();
  const expiry    = ledger.sequence + 120; // ~10 min

  const acc = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(cetes.call(
      "approve",
      addrScVal,
      poolScVal,
      i128ToScVal(amountStroops),
      nativeToScVal(expiry, { type: "u32" }),
    ))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = sim as SorobanRpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Approve simulation failed: ${err.error}`);
  }
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

export async function buildOpenPositionXdr(
  userAddress: string,
  initialStroops: bigint,
  cFactor: bigint,
  loops: number,
): Promise<string> {
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const requests  = buildRequestsVec(buildOpenRequests(initialStroops, cFactor, loops));

  const acc = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = sim as SorobanRpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Open position simulation failed: ${err.error}`);
  }
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

export async function buildClosePositionXdr(
  userAddress: string,
  position: Position,
): Promise<{ approveXdr: string; submitXdr: string }> {
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();

  // Convert token balances to CETES stroops with 0.5% buffer for accrued interest
  const collateralStroops = position.collateralBtokens;
  const debtStroops = BigInt(Math.ceil(position.debtCetes * SCALAR_F * 1.005));

  // Approve enough for net debit (if any — should be near 0 but buffers for interest)
  const netDebitBuffer = BigInt(Math.ceil(position.debtCetes * SCALAR_F * 0.01)); // 1% buffer
  const approveXdr = await buildApproveXdr(userAddress, netDebitBuffer);

  const requests  = buildRequestsVec(buildCloseRequests(collateralStroops, debtStroops));

  const acc = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = sim as SorobanRpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Close position simulation failed: ${err.error}`);
  }
  return {
    approveXdr,
    submitXdr: SorobanRpc.assembleTransaction(tx, sim).build().toXDR(),
  };
}

export async function buildClaimXdr(userAddress: string): Promise<string> {
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const tokenIds  = xdr.ScVal.scvVec([
    nativeToScVal(CETES_SUPPLY_TOKEN_ID, { type: "u32" }),
    nativeToScVal(CETES_BORROW_TOKEN_ID, { type: "u32" }),
  ]);

  const acc = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("claim", addrScVal, tokenIds, addrScVal))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = sim as SorobanRpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Claim simulation failed: ${err.error}`);
  }
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

// ── Submit signed XDR ─────────────────────────────────────────────────────────

export async function submitSignedXdr(signedXdr: string): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK);
  const result = await server.sendTransaction(tx);

  if (result.status === "ERROR") {
    throw new Error(`Transaction failed: ${result.errorResult?.toXDR("base64")}`);
  }

  // Poll for confirmation
  let status = result.status;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await server.getTransaction(result.hash);
    if (poll.status === "SUCCESS") return result.hash;
    if (poll.status === "FAILED") {
      throw new Error(`Transaction failed on-chain: ${poll.resultXdr?.toXDR("base64")}`);
    }
    status = poll.status as any;
  }
  throw new Error("Transaction confirmation timed out");
}
