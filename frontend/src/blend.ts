/**
 * Blend pool interactions — all 5 assets on the Etherfuse mainnet pool.
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

export const POOL_ID   = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
export const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
export const BLND_ID   = "CD25MNVTZDL4Y3XBCPCJXGC7P7Q4BH5B7CTZSN7YXCEUN56HAQBCM7E";
export const NETWORK   = Networks.PUBLIC;
export const RPC_URL   = "https://rpc.lightsail.network/";

// Oracle: base=USD, decimals=14 → price = raw / 1e14
const ORACLE_DEC = 1e14;
// Token rate scale (b_rate / d_rate): 12 decimal places
const RATE_DEC   = 1_000_000_000_000n;
const SCALAR     = 10_000_000n;
const SCALAR_F   = 10_000_000;
const SECONDS_PER_YEAR = 31_536_000;

export const SUPPLY_COLLATERAL  = 2;
export const WITHDRAW_COLLATERAL = 3;
export const REPAY  = 5;
export const BORROW = 4;

// ── Asset registry ────────────────────────────────────────────────────────────

export interface AssetInfo {
  id:           string;   // contract address
  symbol:       string;
  name:         string;
  decimals:     number;
  reserveIndex: number;   // index in the pool's reserve list
  supplyTokenId: number;  // reserve_index * 2 + 1
  borrowTokenId: number;  // reserve_index * 2
  cFactor:      number;   // 0..1, set after fetching
  maxUtil:      number;   // 0..1
}

export const ASSETS: AssetInfo[] = [
  {
    id:           "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    symbol:       "XLM",
    name:         "Stellar Lumens",
    decimals:     7,
    reserveIndex: 0,
    supplyTokenId: 1,
    borrowTokenId: 0,
    cFactor:      0.75,
    maxUtil:      0.70,
  },
  {
    id:           "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    symbol:       "USDC",
    name:         "USD Coin",
    decimals:     7,
    reserveIndex: 1,
    supplyTokenId: 3,
    borrowTokenId: 2,
    cFactor:      0.95,
    maxUtil:      0.95,
  },
  {
    id:           "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV",
    symbol:       "CETES",
    name:         "CETES",
    decimals:     7,
    reserveIndex: 2,
    supplyTokenId: 5,
    borrowTokenId: 4,
    cFactor:      0.80,
    maxUtil:      0.90,
  },
  {
    id:           "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",
    symbol:       "USTRY",
    name:         "US Treasury",
    decimals:     7,
    reserveIndex: 3,
    supplyTokenId: 7,
    borrowTokenId: 6,
    cFactor:      0.90,
    maxUtil:      0.90,
  },
  {
    id:           "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS",
    symbol:       "TESOURO",
    name:         "Brazilian Treasury",
    decimals:     7,
    reserveIndex: 4,
    supplyTokenId: 9,
    borrowTokenId: 8,
    cFactor:      0.80,
    maxUtil:      0.90,
  },
];

export const assetBySymbol = (sym: string) => ASSETS.find(a => a.symbol === sym)!;
export const assetById     = (id: string)  => ASSETS.find(a => a.id === id)!;

// ── RPC ───────────────────────────────────────────────────────────────────────

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

/** Encode oracle Asset::Stellar(addr) variant. */
function assetScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stellar"),
    new Address(contractId).toScVal(),
  ]);
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

// ── Simulate helper ───────────────────────────────────────────────────────────

async function simulate(userAddress: string, op: xdr.Operation): Promise<any> {
  try {
    const acc = await server.getAccount(userAddress);
    const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(op).setTimeout(30).build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
    return scValToNative(sim.result!.retval);
  } catch (e) {
    console.warn("simulate() failed:", e);
    return null;
  }
}

// ── BLND price from CoinGecko ─────────────────────────────────────────────────

let _blndPriceCache: number | null = null;
export async function fetchBlndPrice(userAddress: string): Promise<number> {
  if (_blndPriceCache !== null) return _blndPriceCache;
  try {
    const oracle = new Contract(ORACLE_ID);
    const raw = await simulate(userAddress, oracle.call("lastprice", assetScVal(BLND_ID)));
    _blndPriceCache = raw ? Number(BigInt(raw.price)) / ORACLE_DEC : 0;
  } catch {
    _blndPriceCache = 0;
  }
  console.log("[blend] BLND price (USD):", _blndPriceCache);
  return _blndPriceCache!;
}

// ── Per-asset pool data ───────────────────────────────────────────────────────

export interface ReserveStats {
  asset:         AssetInfo;
  cFactor:       number;
  priceUsd:      number;   // oracle price per 1 full token
  totalSupply:   number;   // full tokens
  totalBorrow:   number;
  available:     number;   // available to borrow
  bRate:         bigint;
  dRate:         bigint;
  interestBorrowApr: number; // % pa — interest rate model
  interestSupplyApr: number; // % pa — after backstop take
  blndSupplyApr:     number; // % pa — BLND emissions on supply side
  blndBorrowApr:     number; // % pa — BLND emissions on borrow side (currently 0)
  netSupplyApr:      number; // interest + blnd
  netBorrowCost:     number; // interest - blnd (usually just interest)
  supplyEps:         bigint; // raw eps from pool, 0 if no emissions
  borrowEps:         bigint;
}

export async function fetchAllReserves(userAddress: string): Promise<ReserveStats[]> {
  const pool      = new Contract(POOL_ID);
  const blndPrice = await fetchBlndPrice(userAddress);

  return Promise.all(
    ASSETS.map(async (asset): Promise<ReserveStats> => {
      let reserveRaw: any = null;
      let priceRaw: any   = null;
      let supplyEmissions: any = null;
      let borrowEmissions: any = null;
      try {
        [reserveRaw, priceRaw, supplyEmissions, borrowEmissions] = await Promise.all([
          simulate(userAddress, pool.call("get_reserve", new Address(asset.id).toScVal())),
          simulate(userAddress, oracle.call("lastprice", assetScVal(asset.id))),
          simulate(userAddress, pool.call("get_reserve_emissions", nativeToScVal(asset.supplyTokenId, { type: "u32" }))),
          simulate(userAddress, pool.call("get_reserve_emissions", nativeToScVal(asset.borrowTokenId, { type: "u32" }))),
        ]);
      } catch (e) {
        console.warn(`fetchAllReserves: error fetching ${asset.symbol}:`, e);
      }

      const priceUsd = priceRaw ? Number(BigInt(priceRaw.price)) / ORACLE_DEC : 0;

      // Debug: log raw contract data so we can verify field names / values
      console.log(`[blend] ${asset.symbol} reserveRaw:`, JSON.stringify(reserveRaw, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
      console.log(`[blend] ${asset.symbol} priceUsd=${priceUsd}, supplyEmissions:`, supplyEmissions, "borrowEmissions:", borrowEmissions);

      const bRate    = reserveRaw ? BigInt(reserveRaw.data.b_rate) : RATE_DEC;
      const dRate    = reserveRaw ? BigInt(reserveRaw.data.d_rate) : RATE_DEC;
      const bSupply  = reserveRaw ? BigInt(reserveRaw.data.b_supply) : 0n;
      const dSupply  = reserveRaw ? BigInt(reserveRaw.data.d_supply) : 0n;

      const totalSupply  = Number(bSupply * bRate / RATE_DEC) / SCALAR_F;
      const totalBorrow  = Number(dSupply * dRate / RATE_DEC) / SCALAR_F;
      const maxUtilActual = reserveRaw ? reserveRaw.config.max_util / SCALAR_F : asset.maxUtil;
      const available    = Math.max(0, totalSupply * maxUtilActual - totalBorrow);
      const cFactor      = reserveRaw ? reserveRaw.config.c_factor / SCALAR_F : asset.cFactor;

      // Interest APR from rate model
      const util     = totalSupply > 0 ? totalBorrow / totalSupply : 0;
      const rBase    = reserveRaw ? reserveRaw.config.r_base / SCALAR_F : 0.01;
      const rOne     = reserveRaw ? reserveRaw.config.r_one  / SCALAR_F : 0.05;
      const rTwo     = reserveRaw ? reserveRaw.config.r_two  / SCALAR_F : 0.10;
      const utilOpt  = reserveRaw ? reserveRaw.config.util   / SCALAR_F : 0.50;
      const rThree   = reserveRaw ? reserveRaw.config.r_three / SCALAR_F : 5.0;
      const backstopRate = 0.10; // 10% backstop take rate approximation

      let interestBorrowApr: number;
      if (util <= utilOpt) {
        interestBorrowApr = (rBase + rOne * (util / utilOpt)) * 100;
      } else {
        const excess = (util - utilOpt) / (1 - utilOpt);
        interestBorrowApr = (rBase + rOne + (rTwo - rOne) * excess + rThree * Math.max(0, excess - 1)) * 100;
      }
      // Supply APR ≈ borrow APR × utilization × (1 - backstop_take)
      const interestSupplyApr = interestBorrowApr * util * (1 - backstopRate);

      // BLND emissions APR
      const supplyEps = supplyEmissions?.eps != null ? BigInt(supplyEmissions.eps) : 0n;
      const borrowEps = borrowEmissions?.eps != null ? BigInt(borrowEmissions.eps) : 0n;
      const totalSupplyUsd = totalSupply * priceUsd;

      // BLND/yr = eps × seconds_per_year / 1e7 / 1e7
      const supplyBlndYr = Number(supplyEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
      const borrowBlndYr = Number(borrowEps) * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;

      const blndSupplyApr = totalSupplyUsd > 0
        ? (supplyBlndYr * blndPrice / totalSupplyUsd) * 100
        : 0;
      const totalBorrowUsd = totalBorrow * priceUsd;
      const blndBorrowApr  = totalBorrowUsd > 0
        ? (borrowBlndYr * blndPrice / totalBorrowUsd) * 100
        : 0;

      console.log(`[blend] ${asset.symbol} util=${util.toFixed(4)} borrowApr=${interestBorrowApr.toFixed(4)}% supplyApr=${interestSupplyApr.toFixed(4)}% blndSupplyApr=${blndSupplyApr.toFixed(4)}% supplyEps=${supplyEps}`);

      return {
        asset: { ...asset, cFactor, maxUtil: maxUtilActual },
        cFactor,
        priceUsd,
        totalSupply,
        totalBorrow,
        available,
        bRate,
        dRate,
        interestBorrowApr,
        interestSupplyApr,
        blndSupplyApr,
        blndBorrowApr,
        netSupplyApr:  interestSupplyApr + blndSupplyApr,
        netBorrowCost: interestBorrowApr - blndBorrowApr,
        supplyEps,
        borrowEps,
      };
    })
  );
}

// ── User position ─────────────────────────────────────────────────────────────

export interface AssetPosition {
  asset:        AssetInfo;
  bTokens:      bigint;
  dTokens:      bigint;
  collateral:   number; // full tokens
  debt:         number;
  equity:       number;
  leverage:     number;
  hf:           number;
}

export interface UserPositions {
  byAsset: Map<string, AssetPosition>; // keyed by asset.id
}

export async function fetchUserPositions(
  userAddress: string,
  reserves: ReserveStats[],
): Promise<UserPositions> {
  const pool = new Contract(POOL_ID);
  const raw  = await simulate(userAddress,
    pool.call("get_positions", new Address(userAddress).toScVal())
  );

  const byAsset = new Map<string, AssetPosition>();
  for (const rs of reserves) {
    const bTokens = BigInt(raw?.collateral?.[rs.asset.reserveIndex] ?? 0);
    const dTokens = BigInt(raw?.liabilities?.[rs.asset.reserveIndex] ?? 0);
    if (bTokens === 0n && dTokens === 0n) continue;

    const collateral = Number(bTokens * rs.bRate / RATE_DEC) / SCALAR_F;
    const debt       = Number(dTokens * rs.dRate / RATE_DEC) / SCALAR_F;
    const equity     = collateral - debt;
    const leverage   = equity > 0 ? collateral / equity : 0;
    const hf         = debt > 0 ? (collateral * rs.cFactor) / debt : Infinity;

    byAsset.set(rs.asset.id, {
      asset: rs.asset,
      bTokens,
      dTokens,
      collateral,
      debt,
      equity,
      leverage,
      hf,
    });
  }
  return { byAsset };
}

export async function fetchAssetBalance(userAddress: string, assetId: string): Promise<number> {
  const token = new Contract(assetId);
  const raw   = await simulate(userAddress,
    token.call("balance", new Address(userAddress).toScVal())
  );
  if (raw === null) return 0;
  const stroops = typeof raw === "bigint" ? raw : BigInt(raw as any);
  return Number(stroops) / SCALAR_F;
}

export async function fetchPendingBlnd(
  userAddress: string,
  asset: AssetInfo,
): Promise<number> {
  const pool = new Contract(POOL_ID);
  let total  = 0;
  for (const tokenId of [asset.supplyTokenId, asset.borrowTokenId]) {
    const raw = await simulate(userAddress,
      pool.call(
        "get_user_emissions",
        new Address(userAddress).toScVal(),
        nativeToScVal(tokenId, { type: "u32" }),
      )
    );
    if (raw?.accrued) total += Number(BigInt(raw.accrued)) / SCALAR_F;
  }
  return total;
}

// ── Leverage math ─────────────────────────────────────────────────────────────

export function leverageAt(loops: number, c: number): number {
  return (1 - Math.pow(c, loops + 1)) / (1 - c);
}

export function hfAt(loops: number, c: number): number {
  return (1 - Math.pow(c, loops + 1)) / (1 - Math.pow(c, loops));
}

function buildOpenRequests(
  assetId: string,
  initialStroops: bigint,
  cFactor: bigint,
  n: number,
): xdr.ScVal[] {
  const items: xdr.ScVal[] = [];
  let balance = initialStroops;
  for (let i = 0; i < n; i++) {
    const supply = balance;
    const borrow = supply * cFactor / SCALAR;
    items.push(buildRequest(assetId, supply, SUPPLY_COLLATERAL));
    items.push(buildRequest(assetId, borrow, BORROW));
    balance = borrow;
  }
  items.push(buildRequest(assetId, balance, SUPPLY_COLLATERAL));
  return items;
}

// ── Transaction builders ──────────────────────────────────────────────────────

export async function buildApproveXdr(
  userAddress: string,
  assetId: string,
  amountStroops: bigint,
): Promise<string> {
  const token     = new Contract(assetId);
  const addrScVal = new Address(userAddress).toScVal();
  const poolScVal = new Address(POOL_ID).toScVal();
  const ledger    = await server.getLatestLedger();
  const expiry    = ledger.sequence + 120;

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(token.call(
      "approve",
      addrScVal,
      poolScVal,
      i128ToScVal(amountStroops),
      nativeToScVal(expiry, { type: "u32" }),
    ))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Approve simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

export async function buildOpenPositionXdr(
  userAddress: string,
  asset: AssetInfo,
  initialStroops: bigint,
  loops: number,
): Promise<string> {
  const cFactorBn = BigInt(Math.round(asset.cFactor * SCALAR_F));
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const requests  = buildRequestsVec(buildOpenRequests(asset.id, initialStroops, cFactorBn, loops));

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Open position simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

export async function buildClosePositionXdr(
  userAddress: string,
  pos: AssetPosition,
): Promise<{ approveXdr: string; submitXdr: string }> {
  // Approve a 1% buffer in case interest has accrued between read and submit
  const netDebitBuf = BigInt(Math.ceil(pos.debt * SCALAR_F * 0.01));
  const approveXdr  = await buildApproveXdr(userAddress, pos.asset.id, netDebitBuf);

  // WITHDRAW all collateral (b-tokens → actual CETES), REPAY all debt + 0.5% buffer
  const debtWithBuf = BigInt(Math.ceil(pos.debt * SCALAR_F * 1.005));
  const requests    = buildRequestsVec([
    buildRequest(pos.asset.id, pos.bTokens, WITHDRAW_COLLATERAL),
    buildRequest(pos.asset.id, debtWithBuf, REPAY),
  ]);

  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const acc       = await server.getAccount(userAddress);
  const tx        = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("submit_with_allowance", addrScVal, addrScVal, addrScVal, requests))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Close simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return {
    approveXdr,
    submitXdr: SorobanRpc.assembleTransaction(tx, sim).build().toXDR(),
  };
}

export async function buildClaimXdr(
  userAddress: string,
  asset: AssetInfo,
): Promise<string> {
  const pool      = new Contract(POOL_ID);
  const addrScVal = new Address(userAddress).toScVal();
  const tokenIds  = xdr.ScVal.scvVec([
    nativeToScVal(asset.supplyTokenId, { type: "u32" }),
    nativeToScVal(asset.borrowTokenId, { type: "u32" }),
  ]);

  const acc = await server.getAccount(userAddress);
  const tx  = new TransactionBuilder(acc, {
    fee: (BigInt(BASE_FEE) * 10n).toString(),
    networkPassphrase: NETWORK,
  })
    .addOperation(pool.call("claim", addrScVal, tokenIds, addrScVal))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim))
    throw new Error(`Claim simulation failed: ${(sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error}`);
  return SorobanRpc.assembleTransaction(tx, sim).build().toXDR();
}

// ── Submit signed XDR ─────────────────────────────────────────────────────────

export async function submitSignedXdr(signedXdr: string): Promise<string> {
  const tx     = TransactionBuilder.fromXDR(signedXdr, NETWORK);
  const result = await server.sendTransaction(tx);
  if (result.status === "ERROR")
    throw new Error(`Send failed: ${result.errorResult?.toXDR("base64")}`);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const poll = await server.getTransaction(result.hash);
    if (poll.status === "SUCCESS") return result.hash;
    if (poll.status === "FAILED")
      throw new Error(`On-chain failure: ${poll.resultXdr?.toXDR("base64")}`);
  }
  throw new Error("Confirmation timed out");
}
