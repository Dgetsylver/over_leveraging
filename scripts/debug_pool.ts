/**
 * Diagnostic: fetch raw reserve data from the Etherfuse Blend pool
 * and print every field so we can verify the APR formula.
 */
import {
  Account,
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

const POOL_ID   = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
const ORACLE_ID = "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS";
const BLND_ID   = "CD25MNVTZDL4Y3XBCPCJXGC7P7Q4BH5B7CTZSN7YXCEUN56HAQBCM7E";
const RPC_URL   = "https://rpc.lightsail.network/";
const NETWORK   = Networks.PUBLIC;

// Null account — valid for simulation only (sequence number irrelevant for read-only sim)
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const ASSETS = [
  { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",     supplyTokenId: 1, borrowTokenId: 0 },
  { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC",    supplyTokenId: 3, borrowTokenId: 2 },
  { id: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", symbol: "CETES",   supplyTokenId: 5, borrowTokenId: 4 },
  { id: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR",  symbol: "USTRY",   supplyTokenId: 7, borrowTokenId: 6 },
  { id: "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS",  symbol: "TESOURO", supplyTokenId: 9, borrowTokenId: 8 },
];

const server = new SorobanRpc.Server(RPC_URL);
const SCALAR_F = 10_000_000;
const RATE_DEC = 1_000_000_000_000n;
const ORACLE_DEC = 1e14;
const SECONDS_PER_YEAR = 31_536_000;

function assetScVal(contractId: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Stellar"),
    new Address(contractId).toScVal(),
  ]);
}

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx  = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(result)) {
    console.error("Sim failed:", (result as any).error);
    return null;
  }
  return scValToNative(result.result!.retval);
}

const bigIntReplacer = (_: string, v: any) => typeof v === "bigint" ? v.toString() : v;

async function main() {
  const pool   = new Contract(POOL_ID);
  const oracle = new Contract(ORACLE_ID);

  // Fetch pool config for backstop_take_rate
  const poolConfig = await sim(pool.call("config"));
  console.log("\nPool config:", JSON.stringify(poolConfig, bigIntReplacer, 2));

  for (const asset of ASSETS) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Asset: ${asset.symbol}`);

    const reserveRaw     = await sim(pool.call("get_reserve", new Address(asset.id).toScVal()));
    const priceRaw       = await sim(oracle.call("lastprice", assetScVal(asset.id)));
    const supplyEmissions = await sim(pool.call("get_reserve_emissions", nativeToScVal(asset.supplyTokenId, { type: "u32" })));
    const borrowEmissions = await sim(pool.call("get_reserve_emissions", nativeToScVal(asset.borrowTokenId, { type: "u32" })));

    console.log("reserve.config:", JSON.stringify(reserveRaw?.config, bigIntReplacer, 2));
    console.log("reserve.data:  ", JSON.stringify(reserveRaw?.data,   bigIntReplacer, 2));

    const priceUsd = priceRaw ? Number(BigInt(priceRaw.price)) / ORACLE_DEC : 0;
    console.log(`price USD: ${priceUsd}`);

    const bRate   = reserveRaw ? BigInt(reserveRaw.data.b_rate) : RATE_DEC;
    const dRate   = reserveRaw ? BigInt(reserveRaw.data.d_rate) : RATE_DEC;
    const bSupply = reserveRaw ? BigInt(reserveRaw.data.b_supply) : 0n;
    const dSupply = reserveRaw ? BigInt(reserveRaw.data.d_supply) : 0n;

    const totalSupply = Number(bSupply * bRate / RATE_DEC) / SCALAR_F;
    const totalBorrow = Number(dSupply * dRate / RATE_DEC) / SCALAR_F;
    const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;

    const rBase   = reserveRaw ? reserveRaw.config.r_base   / SCALAR_F : 0.01;
    const rOne    = reserveRaw ? reserveRaw.config.r_one    / SCALAR_F : 0.05;
    const rTwo    = reserveRaw ? reserveRaw.config.r_two    / SCALAR_F : 0.10;
    const utilOpt = reserveRaw ? reserveRaw.config.util     / SCALAR_F : 0.50;
    const rThree  = reserveRaw ? reserveRaw.config.r_three  / SCALAR_F : 5.0;

    let interestBorrowApr: number;
    if (util <= utilOpt) {
      interestBorrowApr = (rBase + rOne * (util / utilOpt)) * 100;
    } else {
      const excess = (util - utilOpt) / (1 - utilOpt);
      interestBorrowApr = (rBase + rOne + (rTwo - rOne) * excess + rThree * Math.max(0, excess - 1)) * 100;
    }
    const backstopRate = 0.10;
    const interestSupplyApr = interestBorrowApr * util * (1 - backstopRate);

    const supplyEps = supplyEmissions?.eps != null ? BigInt(supplyEmissions.eps) : 0n;

    // Also try with ir_mod applied to r_one
    const irMod = reserveRaw ? Number(reserveRaw.data.ir_mod) / SCALAR_F : 1;
    let borrowAprWithMod: number;
    if (util <= utilOpt) {
      borrowAprWithMod = (rBase + rOne * irMod * (util / utilOpt)) * 100;
    } else {
      const excess = (util - utilOpt) / (1 - utilOpt);
      borrowAprWithMod = (rBase + rOne * irMod + (rTwo - rOne * irMod) * excess + rThree * Math.max(0, excess - 1)) * 100;
    }
    const supplyAprWithMod = borrowAprWithMod * util * (1 - backstopRate);

    console.log(`totalSupply=${totalSupply.toFixed(2)}, totalBorrow=${totalBorrow.toFixed(2)}, util=${(util*100).toFixed(4)}%`);
    console.log(`rBase=${(rBase*100).toFixed(4)}%, rOne=${(rOne*100).toFixed(4)}%, utilOpt=${(utilOpt*100).toFixed(2)}%, irMod=${irMod.toFixed(6)}`);
    console.log(`WITHOUT ir_mod: borrowApr=${interestBorrowApr.toFixed(4)}%, supplyApr=${interestSupplyApr.toFixed(4)}%`);
    console.log(`WITH    ir_mod: borrowApr=${borrowAprWithMod.toFixed(4)}%, supplyApr=${supplyAprWithMod.toFixed(4)}%`);
    console.log(`supplyEps=${supplyEps}`);
    console.log(`supplyEmissions raw:`, JSON.stringify(supplyEmissions, bigIntReplacer));
  }
}

main().catch(console.error);
